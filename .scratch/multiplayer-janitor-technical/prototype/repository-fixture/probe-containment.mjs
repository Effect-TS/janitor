import assert from "node:assert/strict"
import { mkdtempSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { startBridge } from "./bridge.mjs"

const cwd = mkdtempSync(join(tmpdir(), "janitor-containment-"))
const token = randomUUID()
const bridge = await startBridge({ token, cwd, isolateProcesses: true })
async function call(path, input) {
  const response = await fetch(bridge.url + path, {
    method: input === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "x-bridge-epoch": bridge.epoch },
    body: input === undefined ? undefined : JSON.stringify(input),
  })
  const body = await response.json()
  assert.equal(response.status, 200, JSON.stringify(body))
  return body
}
async function finish(id) {
  for (let i = 0; i < 500; i++) {
    const result = await call(`/process/${id}`)
    if (result.closed) return result
    await delay(10)
  }
  throw new Error("containment fixture timeout")
}
try {
  // The main process exits only after the detached descendant confirms spawn.
  // Its delayed file write must never happen after the namespace init exits.
  const childScript =
    "require('fs').writeFileSync('child-started','yes');setTimeout(()=>require('fs').writeFileSync('escaped-write','unsafe'),600)"
  const parentScript = `const {spawn}=require('child_process');const fs=require('fs');const c=spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{detached:true,stdio:'ignore'});c.unref();const t=setInterval(()=>{if(fs.existsSync('child-started')){clearInterval(t);process.stdout.write('descendant-started');}},10);`
  await call("/process", { id: "escape", argv: [process.execPath, "-e", parentScript] })
  const result = await finish("escape")
  assert.equal(result.code, 0, JSON.stringify(result))
  assert.ok(existsSync(join(cwd, "child-started")))
  await call("/freeze", {})
  await delay(800)
  assert.equal(existsSync(join(cwd, "escaped-write")), false)
  await call("/thaw", {})
  await call("/process", {
    id: "cancel",
    argv: [process.execPath, "-e", "setInterval(()=>{},1000)"],
  })
  await delay(100)
  await call("/process/cancel/kill", { signal: "SIGKILL" })
  const canceled = await finish("cancel")
  assert.equal(canceled.signal, "SIGKILL")
  await call("/freeze", {})
  console.log(
    JSON.stringify(
      {
        kind: "pid-namespace-containment",
        checks: [
          "detached descendant starts but cannot write after namespace init exits",
          "checkpoint freeze follows process closure",
          "kill completes before freeze",
        ],
        procRemountTested: false,
        cloudflareTested: false,
      },
      null,
      2,
    ),
  )
} finally {
  await bridge.close()
}
