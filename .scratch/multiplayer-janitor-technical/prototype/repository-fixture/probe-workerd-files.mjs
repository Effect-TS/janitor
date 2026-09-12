import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { Miniflare } from "miniflare"
import { startBridge } from "./bridge.mjs"

const cwd = mkdtempSync(join(tmpdir(), "janitor-workerd-files-"))
const token = randomUUID()
const bridge = await startBridge({ token, cwd })
const mf = new Miniflare({
  modules: true,
  scriptPath: "dist-workerd-files/worker.mjs",
  compatibilityDate: "2026-07-04",
  compatibilityFlags: ["nodejs_compat"],
  bindings: { WORKSPACE: cwd },
  serviceBindings: {
    BRIDGE: async (request) => {
      const url = new URL(request.url)
      const headers = new Headers(request.headers)
      headers.set("authorization", `Bearer ${token}`)
      headers.set("x-bridge-epoch", bridge.epoch)
      const response = await fetch(bridge.url + url.pathname + url.search, {
        method: request.method,
        headers,
        body: request.method === "GET" ? undefined : await request.text(),
      })
      return new Response(await response.arrayBuffer(), {
        status: response.status,
        headers: response.headers,
      })
    },
  },
})
try {
  const response = await mf.dispatchFetch("http://fixture/verify")
  const result = await response.json()
  assert.equal(response.status, 200, JSON.stringify(result))
  assert.equal(result.workerdTested, true)
  console.log(JSON.stringify({ kind: "opencode-workerd-remote-files", cwd, ...result }, null, 2))
} finally {
  await mf.dispose()
  await bridge.close()
}
