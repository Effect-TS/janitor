import assert from "node:assert/strict"
import { test } from "node:test"
import { type ProbeEvent, summarize } from "./report.ts"

const SPEAKER = "111"
const verdicts = (events: ReadonlyArray<ProbeEvent>) =>
  Object.fromEntries(summarize(events).checks.map((check) => [check.id, check.verdict]))

/** One process: boots, discovers its address, joins with SPEAKER already talking. */
const run = (
  bootId: string,
  at: number,
  fix: boolean,
  lastResult: "ok" | "fail",
): Array<ProbeEvent> => [
  { at, kind: "boot", bootId, transitionZeroFix: fix },
  {
    at,
    kind: "stun",
    bootId,
    server: "stun.l.google.com:19302",
    ok: true,
    mapped: "203.0.113.7:40000",
    ms: 30,
  },
  { at: at + 1_000, kind: "ip-discovery", bootId, ok: true, ms: 40, address: "203.0.113.7:40001" },
  {
    at: at + 1_100,
    kind: "ready",
    bootId,
    epoch: 1,
    via: "join",
    presentUserIds: [SPEAKER],
    daveProtocolVersion: 1,
  },
  {
    at: at + 15_000,
    kind: "snapshot",
    bootId,
    epoch: 1,
    udpInTotal: 700,
    daveProtocolVersion: 1,
    inChannelSince: at + 1_100,
    users: {
      [SPEAKER]: {
        e2eeOk: lastResult === "ok" ? 650 : 0,
        e2eeFail: lastResult === "ok" ? 0 : 650,
        passthrough: 0,
        voicedFrames: lastResult === "ok" ? 400 : 0,
        lastResult,
      },
    },
  },
]

test("tells UDP success apart from a speaker who was present but never decrypted", () => {
  const events = [
    ...run("stock", 0, false, "fail"),
    { at: 20_000, kind: "disruption", type: "sigterm" },
    ...run("fixed", 30_000, true, "ok"),
  ]
  assert.deepEqual(
    [
      verdicts(events).A1,
      verdicts(events).A2,
      verdicts(events).B1,
      verdicts(events).B2,
      verdicts(events).B3,
    ],
    ["pass", "pass", "pass", "fail", "pass"],
  )
  assert.equal(verdicts(events).C3, "pass")
})

test("a drop the connection never comes back from fails recovery", () => {
  const events = [
    ...run("stock", 0, false, "ok"),
    { at: 20_000, kind: "disruption", type: "ws-drop" },
  ]
  assert.deepEqual(
    [verdicts(events).C1, verdicts(events).C3, verdicts(events).D1],
    ["fail", "not run", "not run"],
  )
})
