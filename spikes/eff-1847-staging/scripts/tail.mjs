// Streams Workers tail events for a script to an ndjson file, including the
// per-invocation `cpuTime` / `wallTime` the tail protocol reports.
//
//   node scripts/tail.mjs <account-id> <script-name> <out-file>
//
// Reads the OAuth access token from the alchemy profile each (re)connect, so
// a token refresh by `alchemy deploy` is picked up.
import { readFileSync, appendFileSync } from "node:fs"
import { homedir } from "node:os"

const [account, script, out] = process.argv.slice(2)
if (!account || !script || !out) {
  console.error("usage: tail.mjs <account-id> <script-name> <out-file>")
  process.exit(2)
}
const profile = `${homedir()}/.alchemy/profiles/${process.env.ALCHEMY_PROFILE ?? "default"}/cloudflare.json`
const token = () => JSON.parse(readFileSync(profile, "utf8")).values.access
const api = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${script}/tails`
const write = (record) => appendFileSync(out, JSON.stringify({ receivedAt: Date.now(), ...record }) + "\n")

async function createTail() {
  const response = await fetch(api, {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}`, "content-type": "application/json" },
    body: JSON.stringify({}),
  })
  const body = await response.json()
  if (!body.success) throw new Error(`tail create failed: ${JSON.stringify(body.errors)}`)
  return body.result
}

async function deleteTail(id) {
  await fetch(`${api}/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token()}` } }).catch(() => {})
}

async function session() {
  const tail = await createTail()
  console.error(`${new Date().toISOString()} tail ${tail.id} open (expires ${tail.expires_at})`)
  write({ _tag: "tail-open", id: tail.id, expiresAt: tail.expires_at })
  await new Promise((resolve) => {
    const ws = new WebSocket(tail.url, ["trace-v1"])
    ws.addEventListener("open", () => ws.send(JSON.stringify({ filters: [], debug: false })))
    ws.addEventListener("message", async (event) => {
      let data = ""
      try {
        data = typeof event.data === "string" ? event.data : event.data instanceof Blob ? await event.data.text() : Buffer.from(event.data).toString("utf8")
        write({ _tag: "event", ...JSON.parse(data) })
      } catch (error) {
        write({ _tag: "raw", data: String(data).slice(0, 2000), error: String(error) })
      }
    })
    ws.addEventListener("close", (event) => {
      console.error(`${new Date().toISOString()} tail closed (${event.code} ${event.reason})`)
      write({ _tag: "tail-close", code: event.code, reason: event.reason })
      resolve()
    })
    ws.addEventListener("error", (event) => {
      console.error(`${new Date().toISOString()} tail error ${event.message ?? ""}`)
    })
  })
  await deleteTail(tail.id)
}

for (;;) {
  try {
    await session()
  } catch (error) {
    console.error(`${new Date().toISOString()} ${String(error)}`)
    write({ _tag: "error", error: String(error) })
  }
  await new Promise((resolve) => setTimeout(resolve, 3000))
}
