/**
 * The chat egress proxy's deployment check against `Effect-TS/janitor-sandbox`
 * (EFF-3017), until the chat session Entity (EFF-3018) can drive a real turn.
 * Dev-only: nothing in the Worker imports it.
 *
 * It runs the shipped pieces in Node, against the real GitHub and
 * api.multica.ai:
 *
 * - the chat workspace, with a stand-in container, mints the dev bot App's
 *   tokens at acquire and revokes them at release;
 * - the `ChatEgress` entrypoint's context asks it for tokens and lookups over
 *   the control protocol;
 * - `handleChatEgress` applies the policy.
 *
 * A local reverse proxy stands in for Cloudflare's intercept:
 * `http://127.0.0.1:<port>/<host>/<path>` is `https://<host>/<path>` as the
 * container would send it. Real `git` and `multica` go through it, and the
 * REST calls `gh` would make are sent to it directly.
 *
 * It pushes a branch to the sandbox, opens a pull request, merges it and
 * deletes the branch. Needs `CHAT_GITHUB_APP_ID`,
 * `CHAT_GITHUB_APP_PRIVATE_KEY` and `CHAT_MULTICA_TOKEN` in the environment
 * (Infisical `janitor/development`), and `git` and `multica` on the PATH:
 *
 *   node apps/cluster/scripts/chat-egress-check.ts
 *
 * Tokens stay in this process. The report names which token each upstream
 * request carried, never the token.
 */
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import { chatEgressSecrets, chatMulticaWorkspaceId } from "../src/Chat/Config.ts"
import { ChatCredentials } from "../src/Chat/Egress/BotApp.ts"
import { makeEgressContext } from "../src/Chat/Egress/Client.ts"
import { handleChatEgress, type GitHubTokens } from "../src/Chat/Egress/Egress.ts"
import type { ChatEgressProps } from "../src/Chat/Egress/Session.ts"
import { ChatSkills } from "../src/Chat/Sandbox/Skills.ts"
import { makeChatWorkspace, type ChatWorkspaceState } from "../src/Chat/Sandbox/Workspace.ts"
import type { Fetcher } from "../src/PullRequestReview/Sandbox/Container.ts"

const REPO = "Effect-TS/janitor-sandbox"
const SESSION = "egress-check"
const GENERATION = 1
/** What the container sends, to show it never reaches GitHub. */
const CONTAINER_AUTHORIZATION = "Bearer ghp_supplied_by_the_container"

// ---- the workspace, with a container that answers /health and /provision

let registered: ChatEgressProps | undefined

const container: ChatWorkspaceState["container"] = {
  running: false,
  start() {
    ;(this as { running: boolean }).running = true
  },
  monitor: () => new Promise<void>(() => {}),
  destroy() {
    ;(this as { running: boolean }).running = false
    return Promise.resolve()
  },
  getTcpPort: (): Fetcher => ({
    fetch: (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      return Promise.resolve(
        new Response(null, { status: url.pathname === "/provision" ? 204 : 200 }),
      )
    },
  }),
  setInactivityTimeout: () => Promise.resolve(),
  interceptAllOutboundHttp: () => Promise.resolve(),
  interceptOutboundHttps: () => Promise.resolve(),
}

const stored = new Map<string, unknown>()
const state: ChatWorkspaceState = {
  container,
  storage: {
    get: <T>(key: string) => Promise.resolve(stored.get(key) as T | undefined),
    put: (key, value) => {
      stored.set(key, value)
      return Promise.resolve()
    },
  },
  exports: {
    ChatEgress: ({ props }) => {
      registered = props
      return { fetch: () => Promise.reject(new Error("the harness proxies itself")) }
    },
  },
}

const secrets = await Effect.runPromise(chatEgressSecrets)
if (Option.isNone(secrets.app) || Option.isNone(secrets.multicaToken)) {
  console.error(
    "CHAT_GITHUB_APP_ID, CHAT_GITHUB_APP_PRIVATE_KEY and CHAT_MULTICA_TOKEN are required",
  )
  process.exit(2)
}
const multicaToken = Redacted.value(secrets.multicaToken.value)
const multicaWorkspaceId = await Effect.runPromise(chatMulticaWorkspaceId)

const workspace = await Effect.runPromise(
  makeChatWorkspace(state).pipe(
    Effect.provide(Layer.mergeAll(ChatCredentials.layerFrom(secrets), ChatSkills.bundled)),
    Effect.provide(FetchHttpClient.layer),
  ),
)

// ---- which token each upstream request carried

/** Tokens the workspace handed out, by label. Kept to classify requests; never printed. */
const seen = new Map<string, string>()
const remember = (owner: string, tokens: GitHubTokens) => {
  seen.set(tokens.read, `read:${owner}`)
  seen.set(tokens.write, `write:${owner}`)
}

const credentialOf = (request: Request) => {
  const authorization = request.headers.get("authorization")
  if (authorization === null) return "none"
  if (authorization === CONTAINER_AUTHORIZATION) return "CONTAINER'S OWN"
  if (authorization === `Bearer ${multicaToken}`) return "multica"
  const token = authorization.startsWith("Basic ")
    ? atob(authorization.slice(6)).replace(/^x-access-token:/, "")
    : authorization.replace(/^Bearer /, "")
  return seen.get(token) ?? "unknown"
}

const upstreamLog: Array<string> = []

// ---- the proxy

const workspaceFetch = {
  fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await Effect.runPromise(workspace.egressControl(new Request(input, init)))
    const answer = (await response.clone().json()) as { ok?: unknown }
    const query = JSON.parse(String(init?.body)) as { op: string; owner?: string }
    if (query.op === "tokens" && answer.ok != null)
      remember(query.owner!, answer.ok as GitHubTokens)
    return response
  },
}

const HOP_BY_HOP = new Set(["host", "connection", "keep-alive", "transfer-encoding", "expect"])
const DECODED = new Set(["content-encoding", "content-length", "transfer-encoding", "connection"])

const proxy = createServer(async (incoming: IncomingMessage, outgoing: ServerResponse) => {
  try {
    const [, host, ...rest] = (incoming.url ?? "/").split("/")
    const url = `https://${host}/${rest.join("/")}`
    const headers = new Headers()
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (value === undefined || HOP_BY_HOP.has(name)) continue
      headers.set(name, Array.isArray(value) ? value.join(", ") : value)
    }
    const method = incoming.method ?? "GET"
    const request = new Request(url, {
      method,
      headers,
      ...(method === "GET" || method === "HEAD"
        ? {}
        : { body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>, duplex: "half" }),
    } as RequestInit)
    if (registered === undefined) throw new Error("no egress registered")
    const context = makeEgressContext(registered, workspaceFetch)
    let forwardedAny = false
    const response = await Effect.runPromise(
      handleChatEgress(request, {
        ...context,
        upstream: (forwarded) => {
          forwardedAny = true
          const target = new URL(forwarded.url)
          upstreamLog.push(
            `${forwarded.method} ${target.host}${target.pathname} -> ${credentialOf(forwarded)}`,
          )
          return context.upstream(forwarded)
        },
      }),
    )
    if (!forwardedAny) {
      upstreamLog.push(`REFUSED ${response.status}: ${(await response.clone().text()).trim()}`)
    }
    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((value, name) => {
      if (!DECODED.has(name)) responseHeaders[name] = value
    })
    outgoing.writeHead(response.status, responseHeaders)
    if (response.body !== null) {
      for await (const chunk of response.body) outgoing.write(chunk)
    }
    outgoing.end()
  } catch (error) {
    outgoing.writeHead(500)
    outgoing.end(`harness error: ${String(error)}\n`)
  }
})
await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
const port = (proxy.address() as { port: number }).port
const via = (host: string) => `http://127.0.0.1:${port}/${host}`

// ---- the cases

interface Result {
  readonly name: string
  /** `uncredentialed`: forwarded, but every upstream request went without a credential. */
  readonly expected: "works" | "refused" | "uncredentialed"
  readonly ok: boolean
  readonly detail: string
  readonly upstream: ReadonlyArray<string>
}
const results: Array<Result> = []

const run = async (
  name: string,
  expected: Result["expected"],
  step: () => Promise<{ readonly worked: boolean; readonly detail: string }>,
) => {
  const before = upstreamLog.length
  // A step that throws failed to run at all: never a pass, even where a refusal was expected.
  // A refusal counts only when the proxy itself refused, not when GitHub said no.
  const refusedByProxy = () => upstreamLog.slice(before).some((line) => line.startsWith("REFUSED"))
  const uncredentialed = () => {
    const lines = upstreamLog.slice(before)
    return lines.length > 0 && lines.every((line) => line.endsWith("-> none"))
  }
  const outcome = await step().then(
    ({ worked, detail }) => ({
      ok:
        expected === "works"
          ? worked
          : expected === "refused"
            ? !worked && refusedByProxy()
            : uncredentialed(),
      detail,
    }),
    (error: unknown) => ({ ok: false, detail: `the step failed to run: ${String(error)}` }),
  )
  results.push({ name, expected, ...outcome, upstream: upstreamLog.slice(before) })
}

const scratch = mkdtempSync(join(tmpdir(), "chat-egress-check-"))
const home = join(scratch, "home")
const clone = join(scratch, "repo")
const cleanEnv = { PATH: process.env.PATH ?? "", HOME: home, GIT_TERMINAL_PROMPT: "0" }
mkdirSync(home, { recursive: true })

/**
 * Runs a command without blocking: the proxy answering it lives in this
 * process, so a synchronous spawn would deadlock.
 */
const exec = (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd?: string; readonly env: Record<string, string> },
) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
    child.on("error", (error) => resolve({ status: null, stdout, stderr: String(error) }))
    child.on("close", (status) => resolve({ status, stdout, stderr }))
  })

const git = async (args: ReadonlyArray<string>, cwd = clone) => {
  const result = await exec(
    "git",
    [
      "-c",
      "credential.helper=",
      "-c",
      `http.extraHeader=Authorization: ${CONTAINER_AUTHORIZATION}`,
      "-c",
      `url.${via("github.com")}/.insteadOf=https://github.com/`,
      ...args,
    ],
    { cwd, env: cleanEnv },
  )
  if (result.status === null) throw new Error(`git didn't run: ${result.stderr}`)
  const output = `${result.stdout}${result.stderr}`.trim().split("\n").slice(-3).join(" | ")
  return { worked: result.status === 0, detail: output }
}

const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${via("api.github.com")}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: CONTAINER_AUTHORIZATION,
      "user-agent": "janitor-egress-check",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return { status: response.status, text, json: () => JSON.parse(text) as Record<string, unknown> }
}

/** `multica issue list` through the proxy, with the placeholder token the sandbox sets. */
const multicaIssueList = async () => {
  // From the scratch directory: the CLI looks for daemon task markers upward from its cwd.
  const result = await exec("multica", ["issue", "list", "--output", "json"], {
    cwd: scratch,
    env: {
      ...cleanEnv,
      MULTICA_SERVER_URL: via("api.multica.ai"),
      MULTICA_TOKEN: "mul_placeholder",
      MULTICA_WORKSPACE_ID: multicaWorkspaceId,
    },
  })
  let detail = result.stderr.trim().split("\n").slice(-2).join(" | ")
  try {
    const parsed = JSON.parse(result.stdout) as unknown
    const issues = Array.isArray(parsed)
      ? parsed
      : ((parsed as { issues?: Array<unknown> }).issues ?? [])
    detail = `exit ${result.status}, ${issues.length} issues listed`
  } catch {}
  return { worked: result.status === 0, detail }
}

const stamp = new Date()
  .toISOString()
  .replace(/[-:.TZ]/g, "")
  .slice(0, 14)
const branch = `egress-check/${stamp}`
const tag = `egress-check-${stamp}`

try {
  await Effect.runPromise(
    workspace.acquire({
      sessionId: SESSION,
      turnId: "egress-check",
      fresh: true,
      generation: GENERATION,
      multicaWorkspaceId,
      startBudget: 60_000,
      warmFor: 600_000,
    }),
  )

  await run("the workspace minted tokens for Effect-TS at acquire", "works", async () => {
    const response = await workspaceFetch.fetch("http://chat-egress/control", {
      method: "POST",
      headers: { "x-janitor-chat-egress": String(GENERATION) },
      body: JSON.stringify({ op: "tokens", owner: "Effect-TS" }),
    })
    const answer = (await response.json()) as { ok?: unknown }
    return {
      worked: answer.ok != null,
      detail:
        answer.ok != null
          ? "read and write tokens"
          : "none: the bot App has no Effect-TS installation",
    }
  })

  await run(
    "clone the sandbox (git fetch)",
    "works",
    async () => await git(["clone", "--quiet", `https://github.com/${REPO}.git`, clone], scratch),
  )

  await run(`push a new branch (${branch})`, "works", async () => {
    await git(["config", "user.name", "Janitor egress check"])
    await git(["config", "user.email", "tech-ops@effectful.co"])
    writeFileSync(join(clone, `egress-check-${stamp}.md`), `Egress check ${stamp}\n`)
    await git(["add", "."])
    await git(["commit", "--quiet", "-m", `Egress check ${stamp}`])
    return await git(["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`])
  })

  let number: number | undefined
  await run("open a pull request (REST POST /pulls)", "works", async () => {
    const response = await api("POST", `/repos/${REPO}/pulls`, {
      title: `Egress check ${stamp}`,
      head: branch,
      base: "main",
      body: "Opened by the chat egress proxy's deployment check (EFF-3017).",
    })
    if (response.status === 201) number = response.json().number as number
    return { worked: response.status === 201, detail: `${response.status} #${number ?? "-"}` }
  })

  await run("merge the pull request (REST PUT /pulls/{n}/merge)", "works", async () => {
    if (number === undefined) return { worked: false, detail: "no pull request" }
    const response = await api("PUT", `/repos/${REPO}/pulls/${number}/merge`, {
      merge_method: "squash",
    })
    return { worked: response.status === 200, detail: `${response.status}` }
  })

  await run("delete the merged branch (REST DELETE /git/refs/heads/…)", "works", async () => {
    const response = await api("DELETE", `/repos/${REPO}/git/refs/heads/${branch}`)
    return { worked: response.status === 204, detail: `${response.status}` }
  })

  await run("multica issue list", "works", multicaIssueList)

  await run("push to main", "refused", async () => {
    await git(["fetch", "--quiet", "origin", "main"])
    await git(["checkout", "--quiet", "-B", "main", "origin/main"])
    writeFileSync(join(clone, `egress-check-main-${stamp}.md`), "must not land\n")
    await git(["add", "."])
    await git(["commit", "--quiet", "-m", "Must not land on main"])
    return await git(["push", "--quiet", "origin", "HEAD:refs/heads/main"])
  })

  await run(`push a tag (${tag})`, "refused", async () => {
    await git(["tag", tag])
    return await git(["push", "--quiet", "origin", `refs/tags/${tag}`])
  })

  await run("create a release (REST POST /releases)", "refused", async () => {
    const response = await api("POST", `/repos/${REPO}/releases`, {
      tag_name: tag,
      target_commitish: "main",
      name: tag,
    })
    return { worked: response.status === 201, detail: `${response.status} ${response.text.trim()}` }
  })
} finally {
  await Effect.runPromise(workspace.release(GENERATION))
}

await run(
  "after release: fetch the sandbox again",
  "uncredentialed",
  async () => await git(["ls-remote", "origin", "main"]),
)
await run("after release: multica issue list", "uncredentialed", multicaIssueList)

/** Asks GitHub directly whether the revoked tokens still work. */
const revoked = await Promise.all(
  [...seen.entries()].map(async ([token, label]) => {
    const response = await fetch("https://api.github.com/installation/repositories", {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "janitor-egress-check",
      },
    })
    return `${label}: GitHub answers ${response.status}`
  }),
)

proxy.close()
rmSync(scratch, { recursive: true, force: true })

for (const result of results) {
  console.log(
    `${result.ok ? "PASS" : "FAIL"}  ${result.name}: expected ${result.expected}; ${result.detail}`,
  )
  for (const line of result.upstream) console.log(`        ${line}`)
}
console.log("Tokens after release:")
for (const line of revoked) console.log(`        ${line}`)
process.exit(results.every((result) => result.ok) ? 0 : 1)
