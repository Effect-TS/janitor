import assert from "node:assert/strict"
import { test } from "node:test"
import { type ProbeEvent, summarize } from "./report.ts"

const TESTER = "111"
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

test("a recovery counts only the ready its own disruption should cause", () => {
  const start = [
    boot("a", 0),
    ready("a", 1, 1_000, "join", [TESTER]),
    snapshot("a", 1, 15_000, { [TESTER]: speech(14_000) }),
  ]
  // A drop, then a kill that never replaced the process: the same process
  // joining again proves neither a resume nor a restart.
  const sameProcess = verdicts([
    ...start,
    { at: 20_000, kind: "disruption", bootId: "a", type: "ws-drop" },
    { at: 30_000, kind: "disruption", type: "sigkill" },
    ready("a", 2, 40_000, "join", [TESTER]),
    snapshot("a", 2, 55_000, { [TESTER]: speech(50_000) }),
  ])
  assert.deepEqual([sameProcess.C1, sameProcess.C4], ["fail", "fail"])

  const recovered = verdicts([
    ...start,
    { at: 20_000, kind: "disruption", bootId: "a", type: "ws-drop" },
    ready("a", 2, 22_000, "resume", [TESTER]),
    snapshot("a", 2, 30_000, { [TESTER]: speech(28_000) }),
    { at: 40_000, kind: "disruption", type: "sigkill" },
    { at: 41_000, kind: "container-exit", expected: true },
    boot("b", 45_000),
    ready("b", 1, 50_000, "join", [TESTER]),
    snapshot("b", 1, 65_000, { [TESTER]: speech(60_000) }),
  ])
  assert.deepEqual([recovered.C1, recovered.C4], ["pass", "pass"])
})

test("A3 and D1 need voice media and late speech, not just a connection", () => {
  const connected = [
    boot("a", 0),
    { at: 500, kind: "ip-discovery", bootId: "a", ok: true, ms: 40, address: "203.0.113.7:40001" },
    ready("a", 1, 1_000, "join", [TESTER]),
  ]
  const idle = verdicts([...connected, snapshot("a", 1, 2 * 60 * MIN, {}, 0)])
  assert.deepEqual([idle.A2, idle.A3, idle.D1], ["pass", "fail", "not run"])

  const held = summarize([
    ...connected,
    { at: 10 * MIN, kind: "networking", bootId: "a", from: "Ready", to: "Resuming" },
    { at: 10 * MIN + 3_000, kind: "networking", bootId: "a", from: "Resuming", to: "Ready" },
    snapshot("a", 1, 62 * MIN, { [TESTER]: speech(61 * MIN + 1_000) }),
  ]).checks.find((check) => check.id === "D1")
  assert.equal(held?.verdict, "pass")
  assert.match(held?.evidence ?? "", /1 interruptions out of Ready totalling 3\.0 s/)
})
