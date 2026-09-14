// A disposable Git remote reachable only inside the local sandbox container.
// The bridge itself and its clone, process and checkpoint protocols are unchanged.
import { createServer } from "node:http"
import { execFileSync, spawn } from "node:child_process"
import { mkdirSync, existsSync, writeFileSync } from "node:fs"
import { startBridge } from "/opt/janitor/server.mjs"

const remote = "/var/lib/janitor-dev"
mkdirSync(`${remote}/local`, { recursive: true })
mkdirSync("/workspace", { recursive: true })
mkdirSync("/var/lib/janitor", { recursive: true, mode: 0o700 })
if (!existsSync(`${remote}/local/fixture.git`)) {
  const seed = `${remote}/seed`
  execFileSync("git", ["init", "-b", "main", seed])
  writeFileSync(`${seed}/README.md`, "# Janitor local fixture\nValidation code: apricot-47\n")
  execFileSync("git", ["-C", seed, "add", "."])
  execFileSync("git", [
    "-C",
    seed,
    "-c",
    "user.name=Janitor Local",
    "-c",
    "user.email=local@example.invalid",
    "commit",
    "-m",
    "Local fixture",
  ])
  execFileSync("git", ["clone", "--bare", seed, `${remote}/local/fixture.git`])
}
const git = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost")
  if (
    !url.pathname.startsWith("/local/fixture.git/") ||
    request.headers.authorization !==
      `Basic ${Buffer.from("x-access-token:local-fixture").toString("base64")}`
  ) {
    response.writeHead(401, { "www-authenticate": 'Basic realm="local"' }).end()
    return
  }
  const child = spawn("git", ["http-backend"], {
    env: {
      PATH: process.env.PATH,
      GIT_PROJECT_ROOT: remote,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: request.method,
      CONTENT_TYPE: request.headers["content-type"] ?? "",
      REMOTE_USER: "local",
    },
    stdio: ["pipe", "pipe", "ignore"],
  })
  request.pipe(child.stdin)
  const chunks = []
  child.stdout.on("data", (chunk) => chunks.push(chunk))
  child.on("close", () => {
    const output = Buffer.concat(chunks)
    const boundary = output.indexOf("\r\n\r\n")
    if (boundary < 0) {
      response.writeHead(502).end()
      return
    }
    const headers = Object.fromEntries(
      output
        .subarray(0, boundary)
        .toString()
        .split("\r\n")
        .map((line) => {
          const separator = line.indexOf(":")
          return [line.slice(0, separator), line.slice(separator + 1).trim()]
        }),
    )
    response.writeHead(200, headers).end(output.subarray(boundary + 4))
  })
})
await new Promise((resolve) => git.listen(8789, "127.0.0.1", resolve))
const bridge = await startBridge({
  token: process.env.JANITOR_BRIDGE_TOKEN,
  generation: Number(process.env.JANITOR_GENERATION),
  cwd: "/workspace",
  journalPath: "/var/lib/janitor/operations.sqlite",
  port: 8788,
  host: "0.0.0.0",
  cloneOrigin: "http://127.0.0.1:8789",
})
process.once("SIGTERM", async () => {
  await bridge.close()
  git.close()
  process.exit(0)
})
