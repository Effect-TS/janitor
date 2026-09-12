// Model transport deadlines, native retry behavior and command policy.
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Harness, uniqueSessionId, waitFor } from "./support/Harness.ts"

let harness: Harness
beforeAll(async () => {
  harness = await Harness.start({ secret: "scripted-secret" })
})
afterAll(async () => {
  await harness.dispose()
})

const settle = (session: ReturnType<Harness["session"]>, timeoutMs = 60_000) =>
  waitFor(
    () => session.inspect(),
    (state) => state.execution === "idle" || state.execution === "failed",
    { label: "terminal state", timeoutMs },
  )

describe("model transport", () => {
  for (const mode of ["before-first", "midstream", "disconnect", "retry-after"] as const) {
    it(`retries natively after ${mode} and completes`, async () => {
      const session = harness.session(uniqueSessionId(mode))
      await session.faults({ intervalMs: 500, modelInactivityMs: 300 })
      await session.model({ mode, answers: ["after retry"] })
      await session.create()
      await session.admit({ inputId: `msg_${mode}_1`, text: `exercise ${mode}` })
      const done = await settle(session)
      expect(done.execution).toBe("idle")
      expect(done.lastOutcome).toBe("succeeded")
      const state = await session.state()
      expect(state.modelCalls).toBe(2)
      if (mode === "retry-after") {
        const calls = state.journal.filter((entry: any) => entry.kind === "model-call")
        expect(calls[1].time - calls[0].time).toBeGreaterThanOrEqual(1000)
      }
      if (mode === "midstream")
        expect(state.journal.some((entry: any) => entry.kind === "model-stream-cancelled")).toBe(
          true,
        )
    })
  }

  it("keeps a slow but active stream alive past the inactivity deadline", async () => {
    const session = harness.session(uniqueSessionId("activity"))
    await session.faults({ intervalMs: 500, modelInactivityMs: 300 })
    await session.model({ mode: "activity" })
    await session.create()
    await session.admit({ inputId: "msg_activity_1", text: "stream slowly" })
    const done = await settle(session)
    expect(done.lastOutcome).toBe("succeeded")
    expect((await session.state()).modelCalls).toBe(1)
  })

  it("fails the turn visibly after native provider retries are exhausted", async () => {
    const session = harness.session(uniqueSessionId("stall"))
    await session.faults({ intervalMs: 500, modelInactivityMs: 300 })
    await session.model({ mode: "always-stall" })
    await session.create()
    await session.admit({ inputId: "msg_stall_1", text: "stall forever" })
    const done = await settle(session, 90_000)
    expect(done.execution).toBe("failed")
    expect(done.wakeObligation).toBe(false)
    expect((await session.state()).modelCalls).toBe(5)
    const events = (await session.allEvents()).events
    expect(
      events.filter((event) => event.type === "session.retry.scheduled").length,
    ).toBeGreaterThanOrEqual(1)
    expect(events.filter((event) => event.type === "session.execution.failed")).toHaveLength(1)
    // A later ordinary input starts new work; the failed turn is never force-started.
    await session.model({ mode: "text", answers: ["fresh turn"] })
    await session.admit({ inputId: "msg_stall_2", text: "try again" })
    const again = await waitFor(
      () => session.inspect(),
      (state) => state.execution === "idle",
      { label: "fresh turn" },
    )
    expect(again.lastOutcome).toBe("succeeded")
  })

  it("terminalizes an interrupted turn after ten native resumptions", async () => {
    const session = harness.session(uniqueSessionId("exhaust"))
    await session.faults({ intervalMs: 400 })
    await session.model({ mode: "crash", crashes: 11 })
    await session.create()
    await session.admit({ inputId: "msg_exhaust_1", text: "repeatedly interrupted" })
    const done = await settle(session, 120_000)
    expect(done.execution).toBe("failed")
    expect(done.reason).toMatch(/interrupted/i)
    const state = await session.state()
    expect(state.modelCalls).toBe(11)
    // Native recovery released the claim on terminal failure; routine alarms did not spend attempts.
    expect(state.native.timeSuspended).toBeNull()
    const failed = (await session.allEvents()).events.filter(
      (event) => event.type === "session.execution.failed",
    )
    expect(failed).toHaveLength(1)
  })

  it("rejects background and unlimited commands before the shell boundary", async () => {
    const session = harness.session(uniqueSessionId("shell"))
    await session.faults({ intervalMs: 500 })
    await session.model({ mode: "shell-policy", answers: ["policy checked"] })
    await session.create()
    await session.admit({ inputId: "msg_shell_1", text: "exercise shell policy" })
    const done = await settle(session)
    expect(done.execution).toBe("idle")
    const state = await session.state()
    expect(state.modelCalls).toBe(3)
    expect(state.journal.filter((entry: any) => entry.kind === "shell-rejected")).toHaveLength(2)
    const events = (await session.allEvents()).events
    expect(events.filter((event) => event.type === "session.tool.failed")).toHaveLength(2)
    expect(events.filter((event) => event.type === "session.tool.success")).toHaveLength(0)
  })
})
