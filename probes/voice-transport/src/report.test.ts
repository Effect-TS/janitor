import assert from "node:assert/strict"
import { test } from "node:test"
import { type ProbeEvent, renderMarkdown, summarize } from "./report.ts"

const TESTER = "u1a2b3c4d5"
const MIN = 60_000

const verdicts = (events: ReadonlyArray<ProbeEvent>) =>
  Object.fromEntries(summarize(events).checks.map((check) => [check.id, check.verdict]))

const boot = (bootId: string, at: number, fix = false): ProbeEvent => ({
  at,
  kind: "boot",
  bootId,
  transitionZeroFix: fix,
})
const ready = (
  bootId: string,
  epoch: number,
  at: number,
  via: "join" | "resume",
  roster: ReadonlyArray<string>,
): ProbeEvent => ({ at, kind: "ready", bootId, epoch, via, roster, daveProtocolVersion: 1 })
const snapshot = (
  bootId: string,
  epoch: number,
  at: number,
  users: Record<string, unknown>,
  rtpInTotal = 500,
): ProbeEvent => ({
  at,
  kind: "snapshot",
  bootId,
  epoch,
  rtpInTotal,
  daveProtocolVersion: 1,
  users,
})
/** Speech DAVE authenticated, last heard at `at`. */
const speech = (at: number) => ({
  e2eeOk: 600,
  e2eeFail: 0,
  passthrough: 0,
  voicedFrames: 300,
  lastVoicedAt: at,
  lastResult: "ok",
})
const spoke = (bootId: string, epoch: number, at: number) =>
  snapshot(bootId, epoch, at, { [TESTER]: speech(at - 1_000) })
const fired = (bootId: string, epoch: number, at: number): ProbeEvent => ({
  at,
  kind: "fix-applied",
  bootId,
  epoch,
})

test("B2 passes only on authenticated speech from someone there before the bot asked to join", () => {
  const b2 = (roster: ReadonlyArray<string>, counters: Record<string, unknown>) =>
    verdicts([
      boot("a", 0),
      ready("a", 1, 1_000, "join", roster),
      snapshot("a", 1, 15_000, { [TESTER]: counters }),
    ]).B2
  // Arrived during the handshake: not a speaker who was already present.
  assert.equal(b2([], speech(10_000)), "not run")
  // Plaintext the decryptor let through is not end-to-end decryption.
  assert.equal(
    b2([TESTER], { e2eeOk: 0, e2eeFail: 0, passthrough: 600, voicedFrames: 0, lastResult: null }),
    "fail",
  )
  // Authenticated packets with no decoded speech prove nothing about the tester.
  assert.equal(
    b2([TESTER], { e2eeOk: 600, e2eeFail: 0, passthrough: 0, voicedFrames: 0, lastResult: "ok" }),
    "not run",
  )
  assert.equal(b2([TESTER], speech(10_000)), "pass")
})

test("B3 isn't a pass for the workaround unless the workaround fired", () => {
  const withFix = [boot("a", 0, true), ready("a", 1, 1_000, "join", [TESTER])]
  assert.equal(verdicts([...withFix, spoke("a", 1, 15_000)]).B3, "not proven")
  assert.equal(verdicts([...withFix, fired("a", 1, 2_000), spoke("a", 1, 15_000)]).B3, "pass")
})

test("a recovery counts only the ready its own disruption should cause", () => {
  const start = [boot("a", 0), ready("a", 1, 1_000, "join", [TESTER]), spoke("a", 1, 15_000)]
  // A drop, then a kill that never replaced the process: the same process
  // joining again proves neither a resume nor a restart.
  const sameProcess = verdicts([
    ...start,
    { at: 20_000, kind: "disruption", bootId: "a", type: "ws-drop", present: [TESTER] },
    { at: 30_000, kind: "disruption", bootId: "a", type: "sigkill", present: [TESTER] },
    ready("a", 2, 40_000, "join", [TESTER]),
    spoke("a", 2, 55_000),
  ])
  assert.deepEqual([sameProcess.C1, sameProcess.C4], ["fail", "fail"])

  const restart = (type: "sigterm" | "sigkill", outcome?: string) =>
    verdicts([
      ...start,
      { at: 40_000, kind: "disruption", bootId: "a", type, present: [TESTER] },
      ...(outcome ? [{ at: 41_000, kind: "container-end", bootId: "a", outcome }] : []),
      boot("b", 45_000),
      ready("b", 1, 50_000, "join", [TESTER]),
      spoke("b", 1, 65_000),
    ])
  assert.equal(restart("sigkill", "exited").C4, "pass")
  // SIGTERM ignored and the container destroyed is not a graceful restart.
  assert.equal(restart("sigterm", "destroyed").C3, "fail")
  assert.equal(restart("sigterm").C3, "not proven")
})

test("recovery speech must come from the testers present at the disruption, before the next one", () => {
  const start = [boot("a", 0), ready("a", 1, 1_000, "join", [TESTER]), spoke("a", 1, 15_000)]
  const drop = { at: 20_000, kind: "disruption", bootId: "a", type: "ws-drop", present: [TESTER] }
  // The only speech after the resume was recorded after the next disruption.
  const late = verdicts([
    ...start,
    drop,
    ready("a", 2, 22_000, "resume", [TESTER]),
    { at: 25_000, kind: "disruption", bootId: "a", type: "rejoin", present: [TESTER] },
    spoke("a", 2, 40_000),
  ])
  assert.equal(late.C1, "not run")
  // Someone else speaking after the resume doesn't stand in for the tester.
  const other = verdicts([
    ...start,
    drop,
    ready("a", 2, 22_000, "resume", [TESTER, "u9"]),
    snapshot("a", 2, 30_000, { u9: speech(29_000) }),
  ])
  assert.equal(other.C1, "not run")
})

test("A3 needs voice media, and D1 a voice session that lasted the hour", () => {
  const connected = [
    boot("a", 0),
    { at: 500, kind: "ip-discovery", bootId: "a", ok: true, ms: 40, address: "203.0.113.x" },
    ready("a", 1, 1_000, "join", [TESTER]),
  ]
  const idle = verdicts([...connected, snapshot("a", 1, 2 * 60 * MIN, {}, 0)])
  assert.deepEqual([idle.A2, idle.A3, idle.D1], ["pass", "fail", "not proven"])

  const resumedAfter = (outageMs: number) =>
    verdicts([
      ...connected,
      { at: MIN, kind: "networking", bootId: "a", from: "Ready", to: "Resuming" },
      ready("a", 2, MIN + outageMs, "resume", [TESTER]),
      spoke("a", 2, 62 * MIN),
    ]).D1
  assert.equal(resumedAfter(3_000), "pass")
  // A 58-minute outage is not holding the call.
  assert.equal(resumedAfter(58 * MIN), "not proven")
  // Nor is joining again in the same process.
  const rejoined = verdicts([
    ...connected,
    { at: 30 * MIN, kind: "disruption", bootId: "a", type: "rejoin", present: [TESTER] },
    ready("a", 2, 30 * MIN + 2_000, "join", [TESTER]),
    spoke("a", 2, 62 * MIN),
  ]).D1
  assert.equal(rejoined, "not proven")
})

test("the report shows no ids, addresses or free-form text from the events", () => {
  const id = "123456789012345678"
  const report = summarize([
    boot("a", 0),
    {
      at: 1,
      kind: "stun",
      bootId: "a",
      server: `${id}`,
      ok: false,
      error: `EHOSTUNREACH 198.51.100.4 ${id}`,
    },
    {
      at: 2,
      kind: "stun",
      bootId: "a",
      server: "stun.example:3478",
      ok: true,
      mapped: "198.51.100.4:50000",
      ms: 9,
    },
    { at: 3, kind: "ip-discovery", bootId: "a", ok: false, error: `${id} at 198.51.100.4` },
    { at: 4, kind: "ip-discovery", bootId: "a", ok: true, ms: 9, address: "198.51.100.4:50000" },
  ])
  const shown = renderMarkdown(report) + JSON.stringify(report)
  assert.ok(!shown.includes(id) && !shown.includes("100.4"), shown)
})
