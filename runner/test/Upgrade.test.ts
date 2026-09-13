// Release identity, outer compatibility, forward migration and the maintenance
// hold as the upgrade contract requires them, without a repository workspace.
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { RELEASE_MANIFEST, SUPPORTED_NATIVE_MIGRATIONS } from "../src/ReleaseManifest.ts"
import { Harness, sleep, uniqueSessionId, waitFor } from "./support/Harness.ts"

let harness: Harness
beforeAll(async () => {
  harness = await Harness.start({ secret: "scripted-secret" })
})
afterAll(async () => {
  await harness.dispose()
})

const setCompatibility = (id: string, record: unknown) =>
  harness.call("POST", `/__test/sessions/${id}/compatibility`, record)

/** A session that has completed one turn, with its committed compatibility record. */
const settled = async (prefix: string) => {
  const session = harness.session(uniqueSessionId(prefix))
  await session.faults({ intervalMs: 400 })
  await session.model({ mode: "text", answers: ["done"] })
  await session.create()
  await session.admit({ inputId: `msg_${prefix}_1`, text: "first" })
  await waitFor(
    () => session.inspect(),
    (state) => state.execution === "idle",
    { label: `${prefix} first turn` },
  )
  const record = (await session.state()).compatibility
  return { session, record }
}

describe("release identity", () => {
  it("publishes the release manifest on health with no problems", async () => {
    const health = await harness.call("GET", "/v1/health")
    expect(health).toMatchObject({ protocol: 2, release: "test", problems: [] })
    expect(health.manifest).toEqual(RELEASE_MANIFEST)
    expect(health.manifest.nativeMigrations.ids).toEqual(SUPPORTED_NATIVE_MIGRATIONS)
  })

  it("records the state family, format and completed migration set after initialization", async () => {
    const { record } = await settled("record")
    expect(record).toMatchObject({
      formatVersion: RELEASE_MANIFEST.janitorState.format,
      family: RELEASE_MANIFEST.family,
      protocol: 2,
      release: "test",
      nativeMigrations: SUPPORTED_NATIVE_MIGRATIONS,
      inProgress: null,
    })
  })
})

describe("compatibility guards", () => {
  it("resumes an interrupted initialization toward its own target and blocks any other, without mutation", async () => {
    const { session, record } = await settled("partial")
    const partial = {
      ...record,
      nativeMigrations: [],
      inProgress: { target: "20990101000000_elsewhere", release: "other", startedAt: 1 },
    }
    await setCompatibility(session.id, partial)
    await harness.restart()
    const blocked = await session.inspect()
    expect(blocked.execution).toBe("blocked")
    expect(blocked.reason).toContain("did not complete")
    expect(blocked.reason).toContain(
      `${SUPPORTED_NATIVE_MIGRATIONS.length} of ${SUPPORTED_NATIVE_MIGRATIONS.length} supported migrations recorded`,
    )
    expect((await session.admit({ inputId: "msg_partial_2", text: "held" }, 423)).code).toBe(
      "blocked",
    )
    await sleep(900)
    // Nothing repaired or reset the record while it was blocked.
    expect((await session.state()).compatibility).toEqual(partial)

    // The same target, started by this release, is a supported restart.
    await setCompatibility(session.id, {
      ...partial,
      inProgress: {
        target: RELEASE_MANIFEST.nativeMigrations.target,
        release: "test",
        startedAt: 1,
      },
    })
    expect((await session.inspect()).execution).toBe("idle")
    await session.admit({ inputId: "msg_partial_2", text: "resumed" })
    await waitFor(
      () => session.inspect(),
      (state) => state.execution === "idle" && state.admittedInputs === 2,
      { label: "resumed turn" },
    )
    const state = await session.state()
    expect(state.compatibility).toMatchObject({
      inProgress: null,
      nativeMigrations: SUPPORTED_NATIVE_MIGRATIONS,
    })
    expect(state.journal.some((entry: any) => entry.kind === "migration-resumed")).toBe(true)
  })

  it("refuses state written by a family it has no tested path to read", async () => {
    const { session, record } = await settled("family")
    await setCompatibility(session.id, { ...record, family: "janitor-runner-99" })
    await harness.restart()
    const blocked = await session.inspect()
    expect(blocked.execution).toBe("blocked")
    expect(blocked.reason).toMatch(/janitor-runner-99.*no tested path/)
    expect((await session.state()).compatibility.family).toBe("janitor-runner-99")
    await setCompatibility(session.id, record)
    expect((await session.inspect()).execution).toBe("idle")
  })

  it("upgrades a format 1 record in place under a migration intent", async () => {
    const { session, record } = await settled("format1")
    const legacy = {
      formatVersion: 1,
      protocol: 2,
      release: "previous",
      nativeMigrations: record.nativeMigrations,
      inProgress: null,
    }
    await setCompatibility(session.id, legacy)
    await harness.restart()
    expect((await session.inspect()).execution).toBe("idle")
    await session.admit({ inputId: "msg_format1_2", text: "after upgrade" })
    await waitFor(
      () => session.inspect(),
      (state) => state.execution === "idle" && state.admittedInputs === 2,
      { label: "upgraded turn" },
    )
    const state = await session.state()
    expect(state.compatibility).toMatchObject({
      formatVersion: 2,
      family: RELEASE_MANIFEST.family,
      release: "test",
      inProgress: null,
    })
    const kinds = state.journal.map((entry: any) => entry.kind)
    expect(kinds).toContain("migration-started")
    expect(kinds).toContain("state-upgraded")
    expect(kinds.indexOf("state-upgraded")).toBeLessThan(kinds.lastIndexOf("host-created"))
  })
})

describe("maintenance hold", () => {
  it("survives restart, keeps alarms from resuming work, and releases only its own epoch", async () => {
    const session = harness.session(uniqueSessionId("hold"))
    await session.faults({ intervalMs: 400 })
    await session.model({ mode: "text", delayMs: 2000, answers: ["after hold"] })
    await session.create()
    await session.admit({ inputId: "msg_hold_1", text: "long work" })
    await sleep(300)
    const held = await session.maintenance({ hold: true, epoch: 3 })
    expect(held).toMatchObject({ held: true, epoch: 3, quiescent: true, uncertain: false })
    // Repeating the hold is idempotent and an older epoch never overrides it.
    expect(await session.maintenance({ hold: true, epoch: 3 })).toMatchObject({ epoch: 3 })
    expect(await session.maintenance({ hold: true, epoch: 2 })).toMatchObject({
      held: true,
      epoch: 3,
    })
    await harness.restart()
    const blocked = await session.inspect()
    expect(blocked.execution).toBe("blocked")
    expect(blocked.reason).toBe("maintenance hold epoch 3")
    expect(blocked.maintenanceEpoch).toBe(3)
    expect(blocked.alarmAt).toBeNull()
    expect(blocked.wakeObligation).toBe(true)
    await sleep(1500)
    expect(
      (await session.state()).journal.filter((entry: any) => entry.kind === "model-response"),
    ).toHaveLength(0)
    expect((await session.maintenance({ hold: false, epoch: 2 }, 400)).code).toBe("invalid_request")
    const released = await session.maintenance({ hold: false, epoch: 3 })
    expect(released.held).toBe(false)
    expect(released.checks.map((check: any) => [check.name, check.ok])).toEqual([
      ["state", true],
      ["checkpoint", true],
      ["model", true],
      ["bridge", true],
    ])
    const done = await waitFor(
      () => session.inspect(),
      (state) => state.execution === "idle",
      { label: "resume after release" },
    )
    expect(done.lastOutcome).toBe("succeeded")
  })

  it("refuses release while a state check fails and keeps the hold until repaired", async () => {
    const { session, record } = await settled("refused")
    expect(await session.maintenance({ hold: true, epoch: 5 })).toMatchObject({ held: true })
    await setCompatibility(session.id, { ...record, family: "janitor-runner-98" })
    const refused = await session.maintenance({ hold: false, epoch: 5 })
    expect(refused.held).toBe(true)
    expect(refused.checks.find((check: any) => check.name === "state")).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/no tested path/),
    })
    expect((await session.inspect()).reason).toBe("maintenance hold epoch 5")
    await setCompatibility(session.id, record)
    expect(await session.maintenance({ hold: false, epoch: 5 })).toMatchObject({ held: false })
    expect((await session.inspect()).execution).toBe("idle")
  })

  it("lets a newer disconnection outrank a stale release", async () => {
    const { session } = await settled("fence")
    await session.maintenance({ hold: true, epoch: 8 })
    await session.cleanup(1)
    const stale = await session.maintenance({ hold: false, epoch: 8 })
    expect(stale.held).toBe(false)
    expect(stale.checks).toEqual([
      { name: "fence", ok: false, detail: expect.stringMatching(/disconnected/) },
    ])
    expect((await session.inspect()).reason).toBe("disconnected")
  })
})

describe("maintenance without credentials", () => {
  it("refuses release when the session's model credential is missing", async () => {
    const bare = await Harness.start({ secret: undefined })
    try {
      const session = bare.session(uniqueSessionId("nosecret"))
      await session.create()
      await session.maintenance({ hold: true, epoch: 1 })
      const refused = await session.maintenance({ hold: false, epoch: 1 })
      expect(refused.held).toBe(true)
      expect(refused.checks.find((check: any) => check.name === "model")).toMatchObject({
        ok: false,
        detail: expect.stringMatching(/MODEL_SECRET_TEST/),
      })
    } finally {
      await bare.dispose()
    }
  })
})
