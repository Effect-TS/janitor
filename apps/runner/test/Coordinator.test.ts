import { assert, describe, it } from "vite-plus/test"
import { Effect } from "effect"
import { harness, runtimeToken } from "./support/Fakes.ts"
import { REPOSITORY_DIR } from "../src/services/SandboxWorkspace.ts"
import type { TurnOutcome, TurnRequest } from "../src/services/TurnHost.ts"

const create = (h: ReturnType<typeof harness>) =>
  Effect.runPromise(
    h.coordinator.create("s1", { generation: 1, title: "Test", repositoryId: "42" }),
  )
const admit = (h: ReturnType<typeof harness>, inputId: string, text = inputId) =>
  Effect.runPromise(
    h.coordinator.admit("s1", { generation: 1, inputId, text, attribution: { source: "driver" } }),
  )
const events = (h: ReturnType<typeof harness>) =>
  Effect.runPromise(h.coordinator.events("s1", 0, 500)).then((read) =>
    read.events.map((event) => [event.type, (event.data as { inputId?: string }).inputId] as const),
  )
const act = (
  h: ReturnType<typeof harness>,
  action: "retry" | "skip",
  inputId: string,
  attempt: number,
  actionId: string,
) =>
  Effect.runPromise(
    h.coordinator.act("s1", {
      generation: 1,
      inputId,
      attempt,
      action,
      actionId,
      actor: { source: "slack", teammateId: "tm_1" },
    }),
  )

describe("session coordinator", () => {
  it("accepts inputs durably, deduplicates them and runs them in acceptance order", async () => {
    const h = harness()
    const created = await create(h)
    assert.isTrue(created.created)
    assert.isFalse((await create(h)).created)
    const first = await admit(h, "msg_1", "one")
    assert.isFalse(first.duplicate)
    const again = await admit(h, "msg_1", "one")
    assert.isTrue(again.duplicate)
    assert.isTrue(again.payloadMatches)
    const changed = await admit(h, "msg_1", "different")
    assert.isTrue(changed.duplicate)
    assert.isFalse(changed.payloadMatches)
    await admit(h, "msg_2", "two")
    // Acceptance emits before any turn starts; the acknowledgement never waits for the sandbox.
    assert.deepStrictEqual(await events(h), [
      ["turn.accepted", "msg_1"],
      ["turn.accepted", "msg_2"],
    ])
    await h.settle()
    assert.deepStrictEqual(
      h.host.turns.map((turn) => turn.inputId),
      ["msg_1", "msg_2"],
    )
    const read = await Effect.runPromise(h.coordinator.events("s1", 0, 500))
    const types = read.events.map((event) => event.type)
    assert.deepStrictEqual(types, [
      "turn.accepted",
      "turn.accepted",
      "turn.started",
      "turn.stage",
      "turn.stage",
      "turn.stage",
      "turn.completed",
      "turn.started",
      "turn.stage",
      "turn.stage",
      "turn.stage",
      "turn.completed",
    ])
    assert.strictEqual(read.execution, "idle")
    assert.strictEqual(h.sandbox.cloneCount, 1)
    // Each completed turn committed a recovery point and deleted its predecessor.
    assert.strictEqual(h.sandbox.backups.size, 1)
    assert.strictEqual(h.sandbox.deleted.length, 1)
    assert.strictEqual(h.store.recoveryPoint?.inputId, "msg_2")
    assert.strictEqual(h.sandbox.stops >= 2, true)
  })

  it("pauses the queue after an interruption until a teammate retries, restoring the workspace first", async () => {
    const h = harness()
    await create(h)
    await admit(h, "msg_1", "one")
    await h.settle()
    h.host.writes = [[`${REPOSITORY_DIR}/scratch.txt`, "unsaved work"]]
    h.host.outcomes.push({ type: "interrupted", reason: "the sandbox stopped" })
    await admit(h, "msg_2", "two")
    await admit(h, "msg_3", "three")
    await h.settle()
    const paused = await Effect.runPromise(h.coordinator.inspect("s1"))
    assert.strictEqual(paused.execution, "failed")
    assert.deepStrictEqual(
      paused.awaiting && [paused.awaiting.inputId, paused.awaiting.attempt, paused.awaiting.kind],
      ["msg_2", 1, "interrupted"],
    )
    // Later inputs wait: the third input never ran.
    assert.deepStrictEqual(
      h.host.turns.map((turn) => turn.inputId),
      ["msg_1", "msg_2"],
    )
    assert.strictEqual(paused.pendingInputs, 2)
    // The unsaved work is gone once the workspace is restored for the retry.
    h.host.writes = []
    const applied = await act(h, "retry", "msg_2", 1, "click-1")
    assert.strictEqual(applied.outcome, "applied")
    await h.settle()
    assert.isFalse(h.sandbox.files.has(`${REPOSITORY_DIR}/scratch.txt`))
    assert.strictEqual(h.sandbox.restoreCount, 1)
    const retried = h.host.turns[2]!
    assert.strictEqual(retried.inputId, "msg_2")
    assert.strictEqual(retried.attempt, 2)
    assert.match(
      retried.notes[0] ?? "",
      /Attempt 1 of this request was interrupted: the sandbox stopped/,
    )
    assert.deepStrictEqual(
      h.host.turns.map((turn) => turn.inputId),
      ["msg_1", "msg_2", "msg_2", "msg_3"],
    )
    const final = await Effect.runPromise(h.coordinator.inspect("s1"))
    assert.strictEqual(final.execution, "idle")
    assert.isNull(final.awaiting)
  })

  it("deduplicates actions and refuses stale buttons after a skip releases the queue", async () => {
    const h = harness()
    await create(h)
    h.host.outcomes.push({ type: "failed", reason: "provider error" })
    await admit(h, "msg_1", "one")
    await admit(h, "msg_2", "two")
    await h.settle()
    const skipped = await act(h, "skip", "msg_1", 1, "click-a")
    assert.strictEqual(skipped.outcome, "applied")
    assert.strictEqual((await act(h, "skip", "msg_1", 1, "click-a")).outcome, "duplicate")
    assert.strictEqual((await act(h, "retry", "msg_1", 1, "click-b")).outcome, "not_awaiting")
    await h.settle()
    const second = h.host.turns[1]!
    assert.strictEqual(second.inputId, "msg_2")
    assert.deepStrictEqual(second.cancel, ["msg_1"])
    assert.match(second.notes[0] ?? "", /skipped the previous request/)
    assert.strictEqual(h.store.input("msg_1")?.status, "skipped")
    assert.strictEqual(h.store.input("msg_2")?.status, "completed")
    // A button for the skipped attempt is stale once newer work ran.
    h.host.outcomes.push({ type: "interrupted", reason: "timeout" })
    await admit(h, "msg_3", "three")
    await h.settle()
    assert.strictEqual((await act(h, "retry", "msg_1", 1, "click-c")).outcome, "stale")
    assert.strictEqual((await act(h, "retry", "msg_3", 1, "click-d")).outcome, "applied")
  })

  it("treats an attempt left running by a previous incarnation as interrupted", async () => {
    const h = harness()
    await create(h)
    let release: (() => void) | undefined
    h.host.outcomes.push(() =>
      Effect.callback<never>((resume) => {
        release = () => resume(Effect.interrupt)
      }),
    )
    await admit(h, "msg_1", "one")
    const driving = Effect.runPromise(h.coordinator.drive)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.strictEqual(h.store.runningAttempt()?.inputId, "msg_1")
    // The object restarts: the new incarnation finds the running record and interrupts it.
    const restarted = h.restart("inc-2")
    await Effect.runPromise(restarted.coordinator.recover)
    assert.strictEqual(restarted.store.awaiting?.kind, "interrupted")
    assert.match(restarted.store.awaiting?.reason ?? "", /restarted/)
    assert.strictEqual(restarted.store.attempt("msg_1", 1)?.state, "interrupted")
    release?.()
    await driving
  })

  it("keeps the previous recovery point until the replacement is committed and retries saving", async () => {
    const h = harness({ saveRetries: 2 })
    await create(h)
    await admit(h, "msg_1", "one")
    await h.settle()
    const first = h.store.recoveryPoint!
    h.sandbox.backupFailures = 1
    await admit(h, "msg_2", "two")
    await h.settle()
    // One failed upload, then success: the pointer moved and only then was the old one deleted.
    assert.strictEqual(h.store.recoveryPoint?.inputId, "msg_2")
    assert.notStrictEqual(h.store.recoveryPoint?.backup.id, first.backup.id)
    assert.deepStrictEqual(h.sandbox.deleted, [first.backup.id])
    assert.strictEqual(h.store.input("msg_2")?.status, "completed")
    // Persistent failure is visible and holds the queue without rerunning the model.
    h.sandbox.backupFailures = 10
    await admit(h, "msg_3", "three")
    await h.settle()
    const failed = await Effect.runPromise(h.coordinator.inspect("s1"))
    assert.strictEqual(failed.awaiting?.kind, "save_failed")
    assert.strictEqual(h.store.recoveryPoint?.inputId, "msg_2")
    const turnsBefore = h.host.turns.length
    h.sandbox.backupFailures = 0
    assert.strictEqual((await act(h, "retry", "msg_3", 1, "save-retry")).outcome, "applied")
    await h.settle()
    assert.strictEqual(h.host.turns.length, turnsBefore, "saving again does not rerun the model")
    assert.strictEqual(h.store.recoveryPoint?.inputId, "msg_3")
    assert.strictEqual(h.store.attempt("msg_3", 2)?.state, "completed")
  })

  it("reuses a live workspace, restores a replaced one and adopts pushed commits it lost", async () => {
    const h = harness()
    await create(h)
    await admit(h, "msg_1", "one")
    await h.settle()
    const token = runtimeToken(h.sandbox)
    assert.isString(token)
    await admit(h, "msg_2", "two")
    await h.settle()
    assert.strictEqual(h.sandbox.restoreCount, 0, "a clean live workspace is reused")
    assert.strictEqual(runtimeToken(h.sandbox), token)
    // The container is replaced between turns: the next turn restores the recovery point.
    h.sandbox.replace()
    // A publication was pushed before the replacement; the restored checkout lacks its commit.
    await h.kv.put("_janitor_publication", {
      phase: "pushed",
      branch: "janitor/abc",
      commit: "b".repeat(40),
    })
    h.sandbox.git = { head: "a".repeat(40), remoteHead: "b".repeat(40), containsRemote: true }
    await admit(h, "msg_3", "three")
    await h.settle()
    assert.strictEqual(h.sandbox.restoreCount, 1)
    assert.notStrictEqual(runtimeToken(h.sandbox), token)
    assert.include(h.sandbox.commands, "adopted", "the pushed branch was adopted from the remote")
    assert.strictEqual(h.store.input("msg_3")?.status, "completed")
    // A prepared-but-unpushed commit that the restore lost sends the plan back to preparation.
    h.sandbox.replace()
    await h.kv.put("_janitor_publication", {
      phase: "prepared",
      branch: "janitor/abc",
      commit: "c".repeat(40),
    })
    h.sandbox.git = { head: "a".repeat(40), remoteHead: "b".repeat(40), containsRemote: false }
    await admit(h, "msg_4", "four")
    await h.settle()
    assert.strictEqual(
      (await h.kv.get<{ phase: string }>("_janitor_publication"))?.phase,
      "conflict",
    )
  })

  it("interrupts a turn that exceeds its allowance", async () => {
    const h = harness({ turnTimeoutMs: 30 })
    await create(h)
    let interrupted = false
    h.host.outcomes.push((_turn: TurnRequest) =>
      Effect.never.pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            interrupted = true
          }),
        ),
      ),
    )
    await admit(h, "msg_1", "one")
    await h.settle()
    assert.isTrue(interrupted, "the model turn was cancelled, not merely abandoned")
    const state = await Effect.runPromise(h.coordinator.inspect("s1"))
    assert.strictEqual(state.awaiting?.kind, "interrupted")
    assert.match(state.awaiting?.reason ?? "", /allowance/)
  })
})

describe("sandbox loss", () => {
  it("records an interruption when the sandbox stops under an active turn", async () => {
    const h = harness()
    await create(h)
    h.host.outcomes.push(() => Effect.never)
    await admit(h, "msg_1", "one")
    const driving = Effect.runPromise(h.coordinator.drive)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.isTrue(h.coordinator.active())
    await Effect.runPromise(h.coordinator.workspaceLost)
    await driving
    assert.isFalse(h.coordinator.active())
    assert.strictEqual(h.store.awaiting?.kind, "interrupted")
    assert.match(h.store.awaiting?.reason ?? "", /sandbox stopped/)
  })

  it("records model text as it lands and tells the API after every visible event", async () => {
    const h = harness()
    await create(h)
    assert.strictEqual(h.notifies.count, 0)
    h.host.outcomes.push((turn) =>
      Effect.sync(() => {
        turn.message(0, "I'll read the README first.")
        turn.message(1, "One sentence: Effect is a TypeScript toolkit.")
        return { type: "completed", text: "One sentence: Effect is a TypeScript toolkit." }
      }),
    )
    await admit(h, "msg_1", "summarize the readme")
    // Acceptance alone is not news to the caller that just admitted the input.
    assert.strictEqual(h.notifies.count, 0)
    await h.settle()
    const read = await Effect.runPromise(h.coordinator.events("s1", 0, 500))
    const messages = read.events
      .filter((event) => event.type === "turn.message")
      .map(
        (event) =>
          event.data as { inputId: string; attempt: number; ordinal: number; text: string },
      )
    assert.deepStrictEqual(
      messages.map((message) => [message.inputId, message.attempt, message.ordinal, message.text]),
      [
        ["msg_1", 1, 0, "I'll read the README first."],
        ["msg_1", 1, 1, "One sentence: Effect is a TypeScript toolkit."],
      ],
    )
    const types = read.events.map((event) => event.type)
    assert.isBelow(types.indexOf("turn.message"), types.indexOf("turn.completed"))
    assert.isAbove(types.indexOf("turn.message"), types.indexOf("turn.started"))
    // started, three stages, two messages and the completion each announce news.
    assert.strictEqual(h.notifies.count, 7)
  })

  it("starts the model before the checkout is ready and holds tools until it is", async () => {
    const h = harness()
    await create(h)
    let releaseClone!: () => void
    const cloneGate = new Promise<void>((resolve) => {
      releaseClone = resolve
    })
    h.sandbox.beforeClone = () => cloneGate
    const seen: boolean[] = []
    h.host.outcomes.push((turn) =>
      Effect.gen(function* () {
        // The model is running while the clone still waits.
        seen.push(h.readiness.isOpen)
        turn.message(0, "I'll read the README first.")
        releaseClone()
        // What a sandbox tool does before touching the checkout.
        yield* h.readiness.ready.pipe(Effect.orDie)
        seen.push(h.readiness.isOpen)
        return { type: "completed", text: "Done" } satisfies TurnOutcome
      }),
    )
    await admit(h, "msg_1", "summarize")
    await h.settle()
    assert.deepStrictEqual(seen, [false, true])
    const read = await Effect.runPromise(h.coordinator.events("s1", 0, 500))
    assert.deepStrictEqual(
      read.events.map((event) => [event.type, (event.data as { stage?: string }).stage ?? null]),
      [
        ["turn.accepted", null],
        ["turn.started", null],
        ["turn.stage", "preparing"],
        ["turn.message", null],
        ["turn.stage", "working"],
        ["turn.stage", "saving"],
        ["turn.completed", null],
      ],
    )
    assert.strictEqual(h.sandbox.cloneCount, 1)
  })

  it("interrupts the model when the checkout cannot be prepared and fails waiting tools", async () => {
    const h = harness()
    await create(h)
    h.sandbox.cloneFailure = "fatal: repository not found"
    // The model waits on the gate like a tool would; the failed preparation interrupts it.
    h.host.outcomes.push(() => h.readiness.ready.pipe(Effect.orDie, Effect.andThen(Effect.never)))
    await admit(h, "msg_1", "one")
    await h.settle()
    assert.strictEqual(h.store.awaiting?.kind, "interrupted")
    assert.match(h.store.awaiting?.reason ?? "", /repository not found/)
    assert.isFalse(h.readiness.isOpen)
    const gate = await Effect.runPromise(h.readiness.ready.pipe(Effect.flip))
    assert.match(gate.message, /repository not found/)
  })
})
