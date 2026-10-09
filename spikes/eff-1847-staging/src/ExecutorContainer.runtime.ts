import * as Dockerfile from "alchemy/Docker/Dockerfile"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as AgentExecutor from "clanka/AgentExecutor"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as RpcServer from "effect/rpc/RpcServer"
import { execSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { ExecutorContainer } from "./ExecutorContainer.ts"

/**
 * Container guest: clanka's `AgentExecutor.layerRpcServer` over the RpcServer
 * HTTP streaming protocol (`POST /rpc`) and the WebSocket protocol
 * (`GET /ws`), both on the container's `fetch` handler (port 3000), working
 * in `/workspace`.
 *
 *   GET /health   process id, boot time, memory (cgroup), egress CA status
 *
 * Egress: the workspace DO starts the container with `enableInternet: false`
 * and routes HTTP and HTTPS through a Worker handler that enforces the
 * allowlist. HTTPS interception presents certificates from an ephemeral CA
 * that only exists at runtime, so it is appended to the trust bundle here,
 * before any child process (bash, git, npm) starts.
 */
const startedAt = Date.now()
const bootId = Math.random().toString(36).slice(2, 10)
const CLOUDFLARE_CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt"
const BUNDLE = "/tmp/ca-bundle.crt"

const trustEgressCa = () => {
  if (!existsSync(CLOUDFLARE_CA)) return { present: false }
  const system = readFileSync("/etc/ssl/certs/ca-certificates.crt", "utf8")
  writeFileSync(BUNDLE, system + "\n" + readFileSync(CLOUDFLARE_CA, "utf8"))
  process.env.SSL_CERT_FILE = BUNDLE
  process.env.CURL_CA_BUNDLE = BUNDLE
  process.env.GIT_SSL_CAINFO = BUNDLE
  process.env.NODE_EXTRA_CA_CERTS = CLOUDFLARE_CA
  process.env.npm_config_cafile = BUNDLE
  return { present: true, bundle: BUNDLE }
}
let egressCa = trustEgressCa()

const readCgroup = (name: string) => {
  try {
    return readFileSync(`/sys/fs/cgroup/${name}`, "utf8").trim()
  } catch {
    return null
  }
}
const memory = () => ({
  current: readCgroup("memory.current"),
  peak: readCgroup("memory.peak"),
  max: readCgroup("memory.max"),
  rss: process.memoryUsage().rss,
  meminfo: (() => {
    try {
      return readFileSync("/proc/meminfo", "utf8").split("\n").slice(0, 3).join("; ")
    } catch {
      return null
    }
  })(),
})

export default ExecutorContainer.make(
  {
    main: import.meta.url,
    runtime: "node",
    instanceType: "standard-1",
    // git + ripgrep + curl, as janitor's real image will have. The
    // APT::Sandbox::User override and the archive cache in /tmp let apt
    // run under rootless podman (uid 42 is not mapped on this machine).
    dockerfile: Dockerfile.inline`
      FROM node:24-bookworm-slim
      RUN mkdir -p /tmp/apt/partial && apt-get -o APT::Sandbox::User=root update && apt-get -o APT::Sandbox::User=root -o Dir::Cache::archives=/tmp/apt install -y --no-install-recommends git ripgrep curl ca-certificates procps && rm -rf /tmp/apt
      RUN mkdir -p /workspace && printf '# Smoke-test workspace\\n\\nThis AGENTS.md lives inside the Cloudflare container.\\n' > /workspace/AGENTS.md
      ENV IMAGE_REV=2
      WORKDIR /workspace
    `,
  },
  Effect.gen(function* () {
    const http = yield* RpcServer.makeProtocolWithHttpEffect().pipe(Effect.provide(RpcSerialization.layerNdjson))
    const ws = yield* RpcServer.makeProtocolWithHttpEffectWebsocket.pipe(Effect.provide(RpcSerialization.layerNdjson))
    const scope = yield* Scope.make()
    const server = (protocol: RpcServer.Protocol["Service"]) =>
      AgentExecutor.layerRpcServer({ directory: "/workspace" }).pipe(
        Layer.provide(Layer.succeed(RpcServer.Protocol, protocol)),
        Layer.provide(NodeServices.layer),
        Layer.provide(FetchHttpClient.layer),
      )
    yield* Layer.build(server(http.protocol)).pipe(Scope.provide(scope))
    yield* Layer.build(server(ws.protocol)).pipe(Scope.provide(scope))
    console.log(`[container ${bootId}] executor up, egress CA ${JSON.stringify(egressCa)}`)

    return ExecutorContainer.of({
      ping: () => Effect.succeed(`pong from ${bootId}`),
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://container")
        const path = url.pathname.replace(/\/+$/, "") || "/"
        if (path === "/rpc") return yield* http.httpEffect
        if (path === "/ws") return yield* ws.httpEffect
        if (path === "/health") {
          if (!egressCa.present) egressCa = trustEgressCa()
          return HttpServerResponse.jsonUnsafe({
            ok: true,
            bootId,
            pid: process.pid,
            startedAt,
            uptimeMs: Date.now() - startedAt,
            egressCa,
            env: { ACQUIRE: process.env.ACQUIRE ?? null, WORKSPACE_ID: process.env.WORKSPACE_ID ?? null },
            workspace: readdirSync("/workspace"),
            memory: memory(),
            nproc: (() => {
              try {
                return execSync("nproc").toString().trim()
              } catch {
                return null
              }
            })(),
          })
        }
        return HttpServerResponse.empty({ status: 404 })
      }),
    })
  }),
)
