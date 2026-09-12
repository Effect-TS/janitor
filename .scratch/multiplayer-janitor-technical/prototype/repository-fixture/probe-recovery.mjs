import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { startBridge } from "./bridge.mjs"
import { openJournal } from "./recovery-journal.mjs"

const root = mkdtempSync(join(tmpdir(), "janitor-recovery-"))
const token = randomUUID()
const dropped = new Set()
let bridge = await startBridge({
  token,
  cwd: root,
  dropReply: ({ path }) => {
    if ((path === "/process" || path.endsWith("/stdin")) && !dropped.has(path)) {
      dropped.add(path)
      return true
    }
    return false
  },
})
const checks = []
async function call(path, input, epoch = bridge.epoch) {
  const response = await fetch(bridge.url + path, {
    method: input === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "x-bridge-epoch": epoch,
      "content-type": "application/json",
    },
    body: input === undefined ? undefined : JSON.stringify(input),
    signal: AbortSignal.timeout(5000),
  })
  return { status: response.status, body: await response.json() }
}
try {
  const request = {
    id: "once",
    argv: [
      process.execPath,
      "-e",
      "const fs=require('fs');fs.appendFileSync('starts','x');process.stdin.on('data',b=>fs.appendFileSync('input',b));",
    ],
  }
  await assert.rejects(call("/process", request), /fetch failed/)
  assert.equal((await call("/process", request)).body.duplicate, true)
  const input = { seq: 0, base64: Buffer.from("once").toString("base64"), end: true }
  await assert.rejects(call("/process/once/stdin", input), /fetch failed/)
  assert.equal((await call("/process/once/stdin", input)).body.duplicate, true)
  let completed = false
  for (let i = 0; i < 300; i++) {
    if ((await call("/process/once")).body.closed) {
      completed = true
      break
    }
    await delay(10)
  }
  assert.ok(completed)
  assert.equal(readFileSync(join(root, "starts"), "utf8"), "x")
  assert.equal(readFileSync(join(root, "input"), "utf8"), "once")
  checks.push(
    "real socket loss after spawn/stdin acceptance reconciles without repeating either effect",
  )
  const oldEpoch = bridge.epoch
  await bridge.close()
  bridge = await startBridge({ token, cwd: root })
  assert.equal((await call("/process", request, oldEpoch)).status, 409)
  assert.equal(readFileSync(join(root, "starts"), "utf8"), "x")
  checks.push("bridge recreation rejects stale-epoch operation retries instead of executing again")

  const journalPath = join(root, "journal.sqlite")
  const journalURL = new URL("./recovery-journal.mjs", import.meta.url).href
  function crash(mode) {
    const code = `import {openJournal} from ${JSON.stringify(journalURL)};import {appendFileSync} from 'node:fs';const j=openJournal(${JSON.stringify(journalPath)});j.begin('op',1,'immutable payload');if(${JSON.stringify(mode)}==='after-effect')appendFileSync(${JSON.stringify(join(root, "external-effect"))},'x');if(${JSON.stringify(mode)}==='after-commit')j.commit('op',1,{manifestKey:'verified-archive'},{exit:0});process.exit(73);`
    assert.equal(spawnSync(process.execPath, ["--input-type=module", "-e", code]).status, 73)
  }
  crash("before-effect")
  let journal = openJournal(journalPath)
  assert.equal(journal.operation("op").state, "uncertain")
  assert.equal(existsSync(join(root, "external-effect")), false)
  journal.close()
  crash("after-effect")
  journal = openJournal(journalPath)
  assert.equal(journal.operation("op").state, "uncertain")
  assert.equal(readFileSync(join(root, "external-effect"), "utf8"), "x")
  journal.close()
  checks.push(
    "process exits before and after an external effect both retain uncertainty; receipt alone cannot distinguish them",
  )
  crash("after-commit")
  journal = openJournal(journalPath)
  assert.equal(journal.operation("op").state, "complete")
  assert.deepEqual(JSON.parse(journal.workspace().checkpoint), { manifestKey: "verified-archive" })
  assert.equal(journal.begin("op", 1, "immutable payload").state, "complete")
  assert.throws(() => journal.begin("op", 1, "changed payload"), /identity conflict/)
  checks.push(
    "completion and checkpoint pointer survive process exit atomically; retry observes recorded result",
  )
  journal.begin("late", 1, "work")
  journal.disconnect()
  assert.throws(() => journal.commit("late", 1, { manifestKey: "orphan" }, { exit: 0 }), /fenced/)
  assert.throws(() => journal.begin("new", 1, "work"), /fenced/)
  assert.equal(journal.workspace().checkpoint, null)
  assert.equal(journal.operation("op"), undefined)
  journal.close()
  checks.push(
    "disconnection fences late completion and new admission and clears checkpoint/session operation records",
  )
  console.log(
    JSON.stringify(
      {
        kind: "local-recovery-boundaries",
        root,
        checks,
        durableObjectTested: false,
        workerdTested: false,
        externalExactlyOnceClaimed: false,
        detachedDescendantsTested: false,
      },
      null,
      2,
    ),
  )
} finally {
  await bridge.close()
}
