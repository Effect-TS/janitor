// Protocol, generation, maintenance, compatibility and cleanup guards.
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PROTOCOL_HEADER } from "../src/Protocol.ts"
import { Harness, sleep, uniqueSessionId, waitFor } from "./support/Harness.ts"

let harness: Harness
beforeAll(async () => {
  harness = await Harness.start({ secret: "scripted-secret" })
})
afterAll(async () => {
  await harness.dispose()
})

describe("command boundary", () => {
  it("rejects missing credentials, wrong protocol versions and malformed requests distinctly", async () => {
    const unauthorized = await harness.raw("GET", "/v1/sessions/x", undefined, {
      authorization: "Bearer nope",
    })
    expect(unauthorized).toMatchObject({ status: 401, body: { code: "unauthorized" } })
    const wrongProtocol = await harness.raw("GET", "/v1/sessions/x", undefined, {
      [PROTOCOL_HEADER]: "99",
    })
    expect(wrongProtocol).toMatchObject({ status: 426, body: { code: "incompatible_protocol" } })
    const malformed = await harness.raw("PUT", "/v1/sessions/ok-id", { generation: "one" })
    expect(malformed).toMatchObject({ status: 400, body: { code: "invalid_request" } })
    const badId = await harness.raw("GET", "/v1/sessions/bad%20id")
    expect(badId).toMatchObject({ status: 400, body: { code: "invalid_request" } })
    const health = await harness.call("GET", "/v1/health")
    expect(health).toMatchObject({ protocol: 1, release: "test" })
  })

  it("distinguishes missing sessions from stale generations", async () => {
    const session = harness.session(uniqueSessionId("gen"))
    expect((await session.admit({ inputId: "msg_gen_0", text: "x" }, 404)).code).toBe(
      "missing_session",
    )
    expect((await session.events(0, 10, 404)).code).toBe("missing_session")
    await session.create({ generation: 2 })
    expect((await session.create({ generation: 1 }, 409)).code).toBe("stale_generation")
    expect(
      (await session.admit({ inputId: "msg_gen_1", text: "x", generation: 1 }, 409)).code,
    ).toBe("stale_generation")
    expect((await session.cleanup(1, 409)).code).toBe("stale_generation")
  })

  it("holds execution during maintenance, preserves the wake obligation and resumes on release", async () => {
    const session = harness.session(uniqueSessionId("maint"))
    await session.faults({ intervalMs: 400 })
    await session.model({ mode: "text", delayMs: 2500, answers: ["after maintenance"] })
    await session.create()
    await session.admit({ inputId: "msg_maint_1", text: "long work" })
    await sleep(300)
    const held = await session.maintenance({ hold: true, epoch: 7 })
    expect(held).toMatchObject({ held: true, epoch: 7, quiescent: true })
    const blocked = await session.inspect()
    expect(blocked.execution).toBe("blocked")
    expect(blocked.reason).toMatch(/maintenance/)
    expect(blocked.wakeObligation).toBe(true)
    expect((await session.admit({ inputId: "msg_maint_2", text: "during hold" }, 423)).code).toBe(
      "blocked",
    )
    await sleep(1500)
    expect(
      (await session.state()).journal.filter((entry: any) => entry.kind === "model-response"),
    ).toHaveLength(0)
    expect((await session.maintenance({ hold: false, epoch: 6 }, 400)).code).toBe("invalid_request")
    const released = await session.maintenance({ hold: false, epoch: 7 })
    expect(released.held).toBe(false)
    const done = await waitFor(
      () => session.inspect(),
      (state) => state.execution === "idle",
      { label: "resume" },
    )
    expect(done.lastOutcome).toBe("succeeded")
    const admitted = await session.admit({ inputId: "msg_maint_2", text: "after hold" })
    expect(admitted.duplicate).toBe(false)
  })

  it("never initializes native recovery behind a persisted blocker", async () => {
    const session = harness.session(uniqueSessionId("blocker"))
    await session.faults({ intervalMs: 500 })
    await session.model({ mode: "crash", crashes: 1, blockOnCrash: true, answers: ["never"] })
    await session.create()
    await session.admit({
      inputId: "msg_block_1",
      text: "must not recover through unresolved effects",
    })
    await waitFor(
      () => session.inspect(),
      (state) => state.execution === "blocked",
      { label: "blocker" },
    )
    await sleep(2500)
    const state = await session.state()
    expect(state.modelCalls).toBe(1)
    expect(state.journal.some((entry: any) => entry.kind === "alarm-blocked")).toBe(true)
    expect(state.journal.filter((entry: any) => entry.kind === "model-response")).toHaveLength(0)
    expect(state.supervision.obligation).toBe(true)
    const inspection = await session.inspect()
    expect(inspection.reason).toMatch(/uncertain external operation/)
    expect(inspection.claimHeld).toBe(true)
  })

  it("blocks unknown or newer native state before constructing a host", async () => {
    const session = harness.session(uniqueSessionId("compat"))
    await session.faults({ intervalMs: 500 })
    await session.model({ mode: "text", answers: ["ok"] })
    await session.create()
    await session.admit({ inputId: "msg_compat_1", text: "first" })
    await waitFor(
      () => session.inspect(),
      (state) => state.execution === "idle",
      { label: "first turn" },
    )
    const before = (await session.state()).compatibility
    expect(before.inProgress).toBeNull()
    expect(before.nativeMigrations.length).toBeGreaterThan(0)

    await harness.call("POST", `/__test/sessions/${session.id}/compatibility`, {
      ...before,
      nativeMigrations: [...before.nativeMigrations, "99999999999999_future"],
      inProgress: "future-release",
    })
    await harness.restart()
    const blocked = await session.inspect()
    expect(blocked.execution).toBe("blocked")
    expect(blocked.reason).toMatch(/did not complete/)
    expect(
      (await session.admit({ inputId: "msg_compat_2", text: "second" }, 423)).body ?? true,
    ).toBeTruthy()

    await harness.call("POST", `/__test/sessions/${session.id}/compatibility`, {
      ...before,
      formatVersion: 2,
    })
    expect((await session.inspect()).reason).toMatch(/format 2/)

    await harness.call("POST", `/__test/sessions/${session.id}/compatibility`, before)
    expect((await session.inspect()).execution).toBe("idle")
    await session.admit({ inputId: "msg_compat_2", text: "second" })
    await waitFor(
      () => session.inspect(),
      (state) => state.execution === "idle",
      { label: "second turn" },
    )
  })

  it("keeps progressing through failing inspections and retries a failed admission by identity", async () => {
    const session = harness.session(uniqueSessionId("inspect"))
    await session.faults({ intervalMs: 400 })
    await session.model({ mode: "text", answers: ["eventually"] })
    await session.create()
    // A failure before native admission is reported, not hidden: the input is saved,
    // the wake obligation armed, and the caller retries with the same identity.
    await session.faults({ inspectionFailures: 1 })
    expect(
      (await session.admit({ inputId: "msg_inspect_1", text: "wake despite failures" }, 503)).code,
    ).toBe("transport")
    const retried = await session.admit({ inputId: "msg_inspect_1", text: "wake despite failures" })
    expect(retried).toMatchObject({ duplicate: false, payloadMatches: true })
    // Supervision keeps rearming through failed inspections while native work continues.
    await session.faults({ inspectionFailures: 3 })
    const done = await waitFor(
      () => session.inspect(),
      (state) => state.execution === "idle",
      {
        label: "eventual completion",
        timeoutMs: 30_000,
      },
    )
    expect(done.lastOutcome).toBe("succeeded")
    const state = await session.state()
    expect(
      state.journal.filter((entry: any) => entry.kind === "inspection-error").length,
    ).toBeGreaterThanOrEqual(3)
    expect(
      state.journal.filter((entry: any) => entry.kind === "alarm-start").length,
    ).toBeGreaterThanOrEqual(4)
    expect(state.modelCalls).toBe(1)
  })

  it("cleanup fences later work and leaves only a tombstone", async () => {
    const session = harness.session(uniqueSessionId("cleanup"))
    await session.faults({ intervalMs: 400 })
    await session.model({ mode: "text", delayMs: 5000, answers: ["never delivered"] })
    await session.create()
    await session.admit({ inputId: "msg_clean_1", text: "stop by disconnection" })
    await sleep(600)
    expect(await session.cleanup(1)).toEqual({ sessionId: session.id, cleaned: true })
    await sleep(1500)
    const inspection = await session.inspect()
    expect(inspection.execution).toBe("blocked")
    expect(inspection.reason).toBe("disconnected")
    expect(inspection.alarmAt).toBeNull()
    expect(inspection.nativeSessionId).toBeNull()
    expect((await session.admit({ inputId: "msg_clean_2", text: "stale" }, 409)).code).toBe(
      "stale_generation",
    )
    expect((await session.create({ generation: 1 }, 409)).code).toBe("stale_generation")
    expect((await session.events(0, 10, 409)).code).toBe("stale_generation")
    expect(await session.cleanup(1)).toEqual({ sessionId: session.id, cleaned: true })
  })
})
