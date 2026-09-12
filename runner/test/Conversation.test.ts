// Durable conversation scenarios against the pinned SDK in Miniflare.
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Harness, sleep, uniqueSessionId, waitFor } from "./support/Harness.ts"

let harness: Harness
beforeAll(async () => {
  harness = await Harness.start({ secret: "scripted-secret" })
})
afterAll(async () => {
  await harness.dispose()
})

const ofType = (events: ReadonlyArray<any>, type: string) =>
  events.filter((event) => event.type === type)
const textEnded = (events: ReadonlyArray<any>) =>
  ofType(events, "session.text.ended").map((event) => event.data.text)
const idle = (session: ReturnType<Harness["session"]>, timeoutMs = 30_000) =>
  waitFor(
    () => session.inspect(),
    (state) => state.execution === "idle",
    { label: "idle", timeoutMs },
  )

describe("conversation", () => {
  it("admits an input, completes the turn without further requests and exposes events and usage", async () => {
    const session = harness.session(uniqueSessionId("basic"))
    await session.faults({ intervalMs: 500 })
    await session.model({ mode: "text", answers: ["first answer"], inputTokens: 11 })
    const created = await session.create({ title: "basic" })
    expect(created.created).toBe(true)
    expect(created.modelConfigurationId).toBe("test-default")
    const again = await session.create({ title: "basic" })
    expect(again).toEqual({ ...created, created: false })

    const receipt = await session.admit({ inputId: "msg_basic_1", text: "do the work" })
    expect(receipt).toMatchObject({ status: "admitted", duplicate: false, payloadMatches: true })

    const inspection = await idle(session)
    expect(inspection.lastOutcome).toBe("succeeded")
    expect(inspection.wakeObligation).toBe(false)
    expect(inspection.alarmAt).toBeNull()
    expect(inspection.admittedInputs).toBe(1)

    const read = await session.allEvents()
    expect(textEnded(read.events)).toEqual(["first answer"])
    expect(read.events.map((event) => event.type)).toContain("session.inbox.enqueued")
    expect(read.usage).toMatchObject({ input: 11 })
    expect(read.usage.seq).toBe(read.synced)
    const state = await session.state()
    expect(state.modelCalls).toBe(1)
    expect(state.journal.some((entry: any) => entry.kind === "idle")).toBe(true)
  })

  it("delivers queued inputs in acceptance order across turns and accumulates usage", async () => {
    const session = harness.session(uniqueSessionId("queue"))
    await session.faults({ intervalMs: 500 })
    await session.model({
      mode: "text",
      delayMs: 800,
      answers: ["one", "two", "three"],
      inputTokens: 5,
    })
    await session.create()
    await session.admit({
      inputId: "msg_q_1",
      text: "Slack first",
      attribution: { source: "slack" },
    })
    await session.admit({
      inputId: "msg_q_2",
      text: "GitHub second",
      attribution: { source: "github" },
    })
    await session.admit({
      inputId: "msg_q_3",
      text: "Slack third",
      attribution: { source: "slack" },
    })
    const inspection = await idle(session)
    expect(inspection.pendingInputs).toBe(0)
    const read = await session.allEvents()
    const enqueued = ofType(read.events, "session.inbox.enqueued").map(
      (event) => event.data.inboxID,
    )
    expect(enqueued).toEqual(["msg_q_1", "msg_q_2", "msg_q_3"])
    const delivered = ofType(read.events, "session.inbox.delivered").map(
      (event) => event.data.inboxID,
    )
    expect(delivered).toEqual(enqueued)
    expect(textEnded(read.events)).toEqual(["one", "two", "three"])
    expect(read.usage.input).toBe(15)
    expect((await session.state()).modelCalls).toBe(3)
  })

  it("keeps the first payload for a duplicate input id before and after inbox promotion", async () => {
    const session = harness.session(uniqueSessionId("dup"))
    await session.faults({ intervalMs: 500 })
    await session.model({ mode: "text", delayMs: 1500, answers: ["done"] })
    await session.create()
    const first = await session.admit({ inputId: "msg_dup_1", text: "original immutable input" })
    // Before promotion: the inbox still holds the entry.
    const retry = await session.admit({ inputId: "msg_dup_1", text: "changed duplicate" })
    expect(retry).toMatchObject({
      duplicate: true,
      payloadMatches: false,
      payloadHash: first.payloadHash,
    })
    await idle(session)
    // After promotion: the id is recognized from the delivered message.
    const late = await session.admit({ inputId: "msg_dup_1", text: "changed after promotion" })
    expect(late).toMatchObject({ duplicate: true, payloadMatches: false })
    await sleep(1500)
    const read = await session.allEvents()
    expect(ofType(read.events, "session.inbox.enqueued")).toHaveLength(1)
    const enqueued = JSON.stringify(ofType(read.events, "session.inbox.enqueued")[0].data)
    expect(enqueued).toContain("original immutable input")
    expect(enqueued).not.toContain("changed")
    expect((await session.state()).modelCalls).toBe(1)
    expect((await session.inspect()).admittedInputs).toBe(1)
  })

  it("reconciles a saved admission whose reply was lost, and the alarm picks the work up", async () => {
    const session = harness.session(uniqueSessionId("lost"))
    await session.faults({ intervalMs: 500, lostReplyOnce: true })
    await session.model({ mode: "text", answers: ["recovered"] })
    await session.create()
    const attribution = { source: "driver", teammateId: "tm_1" }
    const lost = await harness.raw("POST", `/v1/sessions/${session.id}/inputs`, {
      generation: 1,
      inputId: "msg_lost_1",
      text: "save then lose the reply",
      attribution,
    })
    expect(lost.status).toBe(503)
    const retry = await session.admit({
      inputId: "msg_lost_1",
      text: "save then lose the reply",
      attribution,
    })
    expect(retry).toMatchObject({ duplicate: true, payloadMatches: true })
    await idle(session)
    const read = await session.allEvents()
    expect(ofType(read.events, "session.inbox.enqueued")).toHaveLength(1)
    expect(textEnded(read.events)).toEqual(["recovered"])
  })

  it("recovers after a crash following durable admission without another message", async () => {
    const session = harness.session(uniqueSessionId("crash-admit"))
    await session.faults({ intervalMs: 500, abortAfterAdmission: true })
    await session.model({ mode: "text", answers: ["after crash"] })
    await session.create()
    const before = await session.state()
    const crashed = await harness.raw("POST", `/v1/sessions/${session.id}/inputs`, {
      generation: 1,
      inputId: "msg_crash_1",
      text: "crash after admission",
      attribution: { source: "driver" },
    })
    expect(crashed.status).not.toBe(200)
    const inspection = await idle(session)
    expect(inspection.lastOutcome).toBe("succeeded")
    const state = await session.state()
    expect(state.incarnation).not.toBe(before.incarnation)
    expect(textEnded((await session.allEvents()).events)).toEqual(["after crash"])
    expect(state.journal.some((entry: any) => entry.kind === "alarm-start")).toBe(true)
  })

  it("resumes an interrupted turn through native recovery after the process dies mid-call", async () => {
    const session = harness.session(uniqueSessionId("crash-turn"))
    await session.faults({ intervalMs: 700 })
    await session.model({ mode: "crash", crashes: 1, answers: ["resumed"] })
    await session.create()
    await session.admit({ inputId: "msg_turn_1", text: "interrupt me" })
    const inspection = await idle(session, 40_000)
    expect(inspection.lastOutcome).toBe("succeeded")
    const state = await session.state()
    expect(state.modelCalls).toBe(2)
    const read = await session.allEvents()
    expect(ofType(read.events, "session.synthetic").length).toBeGreaterThan(0)
    expect(textEnded(read.events)).toEqual(["resumed"])
    const constructed = state.journal.filter((entry: any) => entry.kind === "constructed")
    expect(constructed.length).toBeGreaterThanOrEqual(2)
  })

  it("continues admitted work after a full runtime restart with no new request", async () => {
    const session = harness.session(uniqueSessionId("restart"))
    await session.faults({ intervalMs: 700 })
    await session.model({ mode: "text", delayMs: 4000, answers: ["survived restart"] })
    await session.create()
    await session.admit({ inputId: "msg_restart_1", text: "long task" })
    await sleep(500)
    await harness.restart()
    const inspection = await idle(session, 40_000)
    expect(inspection.lastOutcome).toBe("succeeded")
    expect(textEnded((await session.allEvents()).events)).toEqual(["survived restart"])
  })

  it("lets an ordinary question end the turn and an ordinary answer start the next", async () => {
    const session = harness.session(uniqueSessionId("question"))
    await session.faults({ intervalMs: 500 })
    await session.model({ mode: "question", answers: ["ignored", "Great, going with A."] })
    await session.create()
    await session.admit({ inputId: "msg_question_1", text: "start something ambiguous" })
    const asked = await idle(session)
    expect(asked.lastOutcome).toBe("succeeded")
    expect(asked.alarmAt).toBeNull()
    expect(textEnded((await session.allEvents()).events)).toEqual([
      "Which approach do you prefer, A or B?",
    ])
    await session.admit({ inputId: "msg_question_2", text: "Choose A" })
    await idle(session)
    const state = await session.state()
    expect(state.modelCalls).toBe(2)
    for (const call of state.journal.filter((entry: any) => entry.kind === "model-call"))
      expect(call.data.tools).not.toContain("question")
    expect(textEnded((await session.allEvents()).events)).toEqual([
      "Which approach do you prefer, A or B?",
      "Great, going with A.",
    ])
  })

  it("does not let an idle check erase the alarm of an admission that raced it", async () => {
    const session = harness.session(uniqueSessionId("idle-race"))
    await session.faults({ intervalMs: 400, idleDelayMs: 1500 })
    await session.model({ mode: "text", answers: ["first", "second"] })
    await session.create()
    await session.admit({ inputId: "msg_race_1", text: "first" })
    await waitFor(
      () => session.state(),
      (state) => state.journal.some((entry: any) => entry.kind === "idle-inspection"),
      {
        label: "idle inspection",
      },
    )
    await session.admit({ inputId: "msg_race_2", text: "arrived during idle check" })
    await waitFor(
      () => session.state(),
      (state) => state.modelCalls === 2,
      { label: "second turn" },
    )
    await idle(session)
    const state = await session.state()
    expect(state.journal.some((entry: any) => entry.kind === "idle-raced")).toBe(true)
    expect(state.supervision.obligation).toBe(false)
  })

  it("persists the session's model configuration and reports an unavailable record visibly", async () => {
    const alternate = harness.session(uniqueSessionId("alt-model"))
    await alternate.faults({ intervalMs: 500 })
    await alternate.model({ mode: "text", answers: ["alternate"] })
    const created = await alternate.create({ modelConfigurationId: "test-alternate" })
    expect(created.modelConfigurationId).toBe("test-alternate")
    await alternate.admit({ inputId: "msg_alt_1", text: "hello" })
    await idle(alternate)
    expect((await alternate.inspect()).modelConfigurationId).toBe("test-alternate")

    const unknown = harness.session(uniqueSessionId("bad-model"))
    const rejected = await unknown.create({ modelConfigurationId: "retired" }, 400)
    expect(rejected.code).toBe("invalid_request")
  })

  it("fails visibly when the runner secret binding is missing", async () => {
    const isolated = await Harness.start({})
    try {
      const session = isolated.session(uniqueSessionId("no-secret"))
      await session.faults({ intervalMs: 400 })
      await session.model({ mode: "text" })
      await session.create()
      await session.admit({ inputId: "msg_secret_1", text: "hello" })
      const failed = await waitFor(
        () => session.inspect(),
        (state) => state.execution === "failed",
        {
          label: "credential failure",
          timeoutMs: 60_000,
        },
      )
      expect(failed.reason).toMatch(/MODEL_SECRET_TEST/)
      expect(failed.reason).not.toMatch(/scripted-secret/)
      const read = await session.allEvents()
      expect(ofType(read.events, "session.execution.failed")).toHaveLength(1)
      expect(JSON.stringify(read.events)).not.toContain("scripted-secret")
    } finally {
      await isolated.dispose()
    }
  })
})
