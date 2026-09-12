import test from "node:test"
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import {
  verifySlack,
  verifyGitHub,
  slackTime,
  historyBoundary,
  AdmissionLedger,
  reconcilePost,
  outputPlan,
} from "./contract.mjs"
const raw = Buffer.from('{"event":"fixture"}'),
  secret = "non-secret-fixture-key",
  ts = "1789160000"
test("Slack signature binds raw bytes and timestamp; reject stale and malformed signatures", () => {
  const sign = "v0=" + createHmac("sha256", secret).update(`v0:${ts}:`).update(raw).digest("hex")
  assert(verifySlack(raw, ts, sign, secret, Number(ts)))
  assert(!verifySlack(Buffer.from("{}"), ts, sign, secret, Number(ts)))
  assert(!verifySlack(raw, ts, sign, secret, Number(ts) + 301))
  assert(!verifySlack(raw, ts, "x", secret, Number(ts)))
})
test("GitHub signature binds raw bytes and rejects malformed signatures", () => {
  const sign = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex")
  assert(verifyGitHub(raw, sign, secret))
  assert(!verifyGitHub(Buffer.from("{}"), sign, secret))
  assert(!verifyGitHub(raw, "bad", secret))
})
const route = { team: "T1", channel: "C1", private: true, thread: "1789160000.000001" }
const msg = (id, ts = "1789160000.000002", extra = {}) => ({
  team_id: "T1",
  event_id: id,
  event: {
    type: "message",
    channel: "C1",
    thread_ts: route.thread,
    ts,
    user: "U1",
    text: "original",
    ...extra,
  },
})
function ledger(run) {
  const l = new AdmissionLedger()
  try {
    l.member("U1", true)
    run(l)
  } finally {
    l.close()
  }
}
test("mention/message overlap creates one immutable logical input", () =>
  ledger((l) => {
    const a = l.admitSlack(msg("E1", undefined, { type: "app_mention" }), route),
      b = l.admitSlack(msg("E2", undefined, { text: "changed retry" }), route)
    assert.equal(a.accepted_seq, b.accepted_seq)
    assert.equal(JSON.parse(b.payload).text, "original")
  }))
test("separate identical messages remain distinct inputs in acceptance order", () =>
  ledger((l) => {
    const a = l.admitSlack(msg("E1", "1789160000.000004"), route),
      b = l.admitSlack(msg("E2", "1789160000.000003"), route)
    assert.equal(a.accepted_seq, 1)
    assert.equal(b.accepted_seq, 2)
  }))
test("removal before acceptance rejects durably even after restoration", () =>
  ledger((l) => {
    l.member("U1", false)
    assert.equal(l.admitSlack(msg("E1"), route).outcome, "unauthorized")
    l.member("U1", true)
    assert.equal(l.admitSlack(msg("E2"), route).outcome, "unauthorized")
  }))
test("removal after acceptance preserves accepted retry and original author", () =>
  ledger((l) => {
    const a = l.admitSlack(msg("E1"), route)
    l.member("U1", false)
    assert.deepEqual(l.admitSlack(msg("E2"), route), a)
  }))
for (const [name, event] of [
  ["bot", { bot_id: "B1" }],
  ["app", { app_id: "A1" }],
  ["edit", { subtype: "message_changed" }],
  ["delete", { subtype: "message_deleted" }],
])
  test(name + " is not a new human instruction", () =>
    ledger((l) =>
      assert.notEqual(l.admitSlack(msg("E1", undefined, event), route).outcome, "accepted"),
    ),
  )
test("public and unrelated threads cannot admit input", () =>
  ledger((l) => {
    assert.equal(l.admitSlack(msg("E1"), { ...route, private: false }).outcome, "public-channel")
    assert.equal(
      l.admitSlack(msg("E2", "1789160000.000003", { thread_ts: "1789160000.000009" }), route)
        .outcome,
      "unrelated-thread",
    )
  }))
test("history pagination duplicates and concurrent post-boundary messages do not change context", () => {
  const m = (ts, thread_ts = route.thread, channel = "C1") => ({ ts, thread_ts, channel })
  const source = [
    m("1789160000.000004"),
    m("1789160000.000002"),
    m("1789160000.000001"),
    m("1789160000.000002"),
    m("1789160000.000000", "other"),
    m("1789160000.000000", route.thread, "other"),
  ]
  assert.deepEqual(
    historyBoundary(source, {
      team: "T1",
      channel: "C1",
      thread: route.thread,
      initiator: "1789160000.000002",
    }).map((m) => m.ts),
    ["1789160000.000001", "1789160000.000002"],
  )
  assert(slackTime("1789160000.000002") > slackTime("1789160000.000001"))
})
test("ambiguous publication needs a positive unique match, not a negative read", () => {
  assert.equal(reconcilePost({ state: "uncertain", matches: [] }).action, "blocked")
  assert.equal(reconcilePost({ state: "uncertain", matches: [{ id: "1" }] }).remoteID, "1")
  assert.equal(
    reconcilePost({ state: "uncertain", matches: [{ id: "1" }, { id: "2" }] }).action,
    "blocked",
  )
  assert.equal(reconcilePost({ state: "known-rejected", matches: [] }).action, "retry-safe")
})
test("coalescing preserves substantive ordering and terminal output", () => {
  assert.deepEqual(
    outputPlan([
      { seq: 1, turn: "a", kind: "progress" },
      { seq: 2, turn: "a", kind: "substantive" },
      { seq: 3, turn: "a", kind: "progress" },
      { seq: 4, turn: "a", kind: "terminal" },
      { seq: 5, turn: "b", kind: "progress" },
      { seq: 6, turn: "b", kind: "progress" },
    ]).map((x) => x.seq),
    [2, 4, 6],
  )
})

test("overlapping envelopes each retain their receipt identity", () =>
  ledger((l) => {
    l.admitSlack(msg("E1"), route)
    l.admitSlack(msg("E2"), route)
    assert.equal(l.db.prepare("SELECT count(*) AS n FROM receipt").get().n, 2)
    assert.throws(
      () => l.admitSlack(msg("E2", "1789160000.000009"), route),
      /receipt identity conflict/,
    )
  }))
test("matching timestamps cannot route another channel into a session", () =>
  ledger((l) => {
    assert.equal(
      l.admitSlack(msg("E1", undefined, { channel: "C2" }), route).outcome,
      "unrelated-conversation",
    )
  }))
test("late progress cannot replace terminal output", () => {
  assert.deepEqual(
    outputPlan([
      { seq: 1, turn: "a", kind: "terminal" },
      { seq: 2, turn: "a", kind: "progress" },
    ]).map((x) => x.seq),
    [1],
  )
})

import { parseGitHubJSON } from "./github-json.mjs"
test("GitHub delivery IDs retain exact digits above the safe integer limit", () => {
  const parsed = parseGitHubJSON(
    '{"id":3842322426589348123,"repository_id":1323166030,"nested":{"id":3842322426589348124}}',
  )
  assert.equal(parsed.id, "3842322426589348123")
  assert.equal(parsed.nested.id, "3842322426589348124")
  assert.equal(parsed.repository_id, 1323166030)
  assert.notEqual(parsed.id, parsed.nested.id)
})
test("GitHub JSON preserves numeric strings and normal JSON scalar types", () => {
  assert.deepEqual(
    parseGitHubJSON(
      '{"id":"3842322426589348123","duration":0.2,"redelivery":false,"missing":null}',
    ),
    { id: "3842322426589348123", duration: 0.2, redelivery: false, missing: null },
  )
})

import { slackInstruction } from "./contract.mjs"
test("edit/delete arriving first cannot poison the original message admission", () =>
  ledger((l) => {
    const original = msg("original")
    const edit = {
      ...original,
      event_id: "edit",
      event: {
        type: "message",
        subtype: "message_changed",
        channel: "C1",
        message: original.event,
      },
    }
    const deletion = {
      ...original,
      event_id: "delete",
      event: {
        type: "message",
        subtype: "message_deleted",
        channel: "C1",
        deleted_ts: original.event.ts,
      },
    }
    assert.equal(slackInstruction(edit), undefined)
    assert.equal(slackInstruction(deletion), undefined)
    assert.equal(l.admitSlack(slackInstruction(original), route).accepted_seq, 1)
  }))
