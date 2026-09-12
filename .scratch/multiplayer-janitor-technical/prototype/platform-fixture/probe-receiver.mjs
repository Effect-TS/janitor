import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
const { Miniflare, convertV4MiniflareOptions } = await import(
  pathToFileURL(process.env.FIXTURE_MINIFLARE_MODULE).href
)
const directory = mkdtempSync(join(tmpdir(), "janitor-delivery-journal-"))
const secret = "local-fixture-signing-secret"
const options = {
  name: "fixture",
  modules: true,
  scriptPath: new URL("receiver.mjs", import.meta.url).pathname,
  compatibilityDate: "2026-09-11",
  durableObjects: { JOURNAL: { className: "Journal", useSQLite: true } },
  durableObjectsPersist: directory,
  bindings: {
    SLACK_SIGNING_SECRET: secret,
    FIXTURE_CONTROL_TOKEN: "local-control",
    SLACK_TEAM_ID: "T1",
    SLACK_APP_ID: "A1",
    SLACK_CHANNEL_ID: "C1",
  },
}
let mf
const checks = []
const envelope = (id, channel = "C1") => ({
  type: "event_callback",
  team_id: "T1",
  api_app_id: "A1",
  event_id: id,
  event: { type: "message", channel, user: "U1", ts: "100.000001", text: "synthetic fixture" },
})
function signed(body, age = 0) {
  const raw = JSON.stringify(body),
    timestamp = String(Math.floor(Date.now() / 1000) - age)
  return {
    method: "POST",
    body: raw,
    headers: {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature":
        "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:${raw}`).digest("hex"),
    },
  }
}
const send = (body, age) => mf.dispatchFetch("https://fixture/slack/events", signed(body, age))
const control = (path, body) =>
  mf.dispatchFetch("https://fixture" + path, {
    method: body ? "POST" : "GET",
    headers: { authorization: "Bearer local-control" },
    body: body ? JSON.stringify(body) : undefined,
  })
try {
  mf = new Miniflare({ ...convertV4MiniflareOptions(options), resourcePersistencePath: directory })
  assert.equal((await mf.dispatchFetch("https://fixture/evidence")).status, 401)
  assert.equal((await send(envelope("stale"), 301)).status, 401)
  const invalid = signed(envelope("invalid"))
  invalid.body = "{}"
  assert.equal((await mf.dispatchFetch("https://fixture/slack/events", invalid)).status, 401)
  checks.push("raw signature, stale timestamp, and control authentication")
  assert.deepEqual(
    await (await send({ type: "url_verification", challenge: "challenge" })).json(),
    { challenge: "challenge" },
  )
  checks.push("signed URL verification")
  assert.equal((await send(envelope("first"))).status, 200)
  assert.equal((await send(envelope("first"))).status, 200)
  assert.equal((await send(envelope("other", "C2"))).status, 200)
  assert.equal((await send({ ...envelope("wrong-team"), team_id: "T2" })).status, 403)
  let evidence = await (await control("/evidence")).json()
  assert.equal(evidence.receipts.length, 1)
  assert.equal(evidence.attempts.length, 2)
  checks.push("transport duplicate receipts and app/channel isolation")
  assert.equal((await control("/faults", { before: 1, after: 0 })).status, 200)
  assert.equal((await send(envelope("before"))).status, 503)
  assert.equal((await (await control("/evidence")).json()).receipts.length, 1)
  assert.equal((await send(envelope("before"))).status, 200)
  checks.push("failure before persistence recovered on retry")
  assert.equal((await control("/faults", { before: 0, after: 1 })).status, 200)
  assert.equal((await send(envelope("after"))).status, 503)
  assert.equal((await (await control("/evidence")).json()).receipts.length, 3)
  await mf.dispose()
  mf = new Miniflare({ ...convertV4MiniflareOptions(options), resourcePersistencePath: directory })
  assert.equal((await send(envelope("after"))).status, 200)
  evidence = await (await control("/evidence")).json()
  assert.equal(evidence.receipts.length, 3)
  assert.equal(evidence.attempts.length, 6)
  checks.push("commit before failed acknowledgment survives runtime restart")
  const first = await (await control("/events?after=0")).json()
  assert.equal(first.length, 3)
  assert.equal((await (await control(`/events?after=${first[2].cursor}`)).json()).length, 0)
  checks.push("authenticated journal export cursor")
  console.log(JSON.stringify({ checks, passed: checks.length, platformCalls: 0 }, null, 2))
} finally {
  await mf?.dispose()
  rmSync(directory, { recursive: true, force: true })
}
