import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, layer } from "@effect/vitest"
import * as Clock from "effect/Clock"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Prompt from "effect/ai/Prompt"
import { resumeMessage, switchedOffMessage, wrapUpMessage } from "@janitor/domain/Chat/Prompt"
import { type ChatThread, sessionKey } from "../../src/Chat/Platform.ts"
import type { TranscriptResult, TranscriptTurn } from "../../src/Chat/Session.ts"
import {
  discordThread,
  makeSessionHarness,
  quotaExhausted,
  run,
  say,
  seen,
  type SessionHarness,
  slackThread,
} from "./sessionHarness.ts"

/**
 * The chat session entity (EFF-3018) with its clanka agent, driven through
 * a fake platform, a fake model and a fake sandbox executor.
 */

/** The deployment's environment; the bot is on while the API URL and key are set. */
const env: Record<string, string> = {
  CHAT_AI_API_URL: "https://ai.test/v1",
  CHAT_AI_API_KEY: "test-key",
}

const Services = NodeServices.layer.pipe(
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
)

const test = <A, E, R>(body: (harness: SessionHarness) => Effect.Effect<A, E, R>) =>
  Effect.scoped(Effect.flatMap(makeSessionHarness, body))

/** Sends a message to `thread`, and returns it. */
const send = (
  harness: SessionHarness,
  thread: ChatThread,
  text: string,
  options?: Parameters<SessionHarness["message"]>[1],
) =>
  Effect.gen(function* () {
    const message = yield* harness.message(text, options)
    yield* harness.deliver(thread, message)
    return message
  })

/** Waits until the model has been called `count` times in all. */
const modelCalls = (harness: SessionHarness, count: number) =>
  harness.until(
    Effect.sync(() => harness.model.prompts.length >= count),
    `model call ${count}`,
  )

const available = (transcript: TranscriptResult) => {
  if (transcript._tag !== "Available") throw new Error("The session has no transcript")
  return transcript
}

/** The transcript's turns, without their generated ids and their history. */
const turns = (transcript: TranscriptResult) =>
  available(transcript).turns.map(({ turnId: _, messages: _messages, ...turn }) => turn)

/** Each stored message's id and gate outcome. */
const stored = (transcript: TranscriptResult) =>
  available(transcript).messages.map((message) => [message.id, message.gate])

const gates = (transcript: TranscriptResult) =>
  available(transcript).messages.map((message) => message.gate)

const lastTurn = (harness: SessionHarness, thread: ChatThread) =>
  Effect.map(harness.transcript(thread), (transcript) => available(transcript).turns.at(-1))

/** Waits until the thread's latest turn has left `running`. */
const turnEnded = (harness: SessionHarness, thread: ChatThread) =>
  harness.until(
    Effect.map(
      lastTurn(harness, thread),
      (turn) => turn !== undefined && turn.status !== "running",
    ),
    "the turn to end",
  )

/** A first turn in `thread`: a mention the model answers at once. */
const firstTurn = (harness: SessionHarness, thread: ChatThread) =>
  Effect.gen(function* () {
    const calls = harness.model.prompts.length
    const replies = harness.platform.replies.length
    yield* send(harness, thread, "Hello there.", { mention: true })
    yield* modelCalls(harness, calls + 1)
    harness.model.answer(say("Hello."))
    yield* harness.until(
      Effect.sync(() => harness.platform.replies.length > replies),
      "the first reply",
    )
  })

/** Starts a turn whose first script runs until the test finishes it. */
const longTurn = (harness: SessionHarness, thread: ChatThread, text: string) =>
  Effect.gen(function* () {
    harness.sandboxes.hang = true
    const calls = harness.model.prompts.length
    const scripts = harness.sandboxes.scripts.length
    yield* send(harness, thread, text, { mention: true })
    yield* modelCalls(harness, calls + 1)
    harness.model.answer(run("pnpm test"))
    yield* harness.until(
      Effect.sync(() => harness.sandboxes.scripts.length > scripts),
      "the script to start",
    )
  })

const finished = (
  turn: Partial<Omit<TranscriptTurn, "turnId">>,
): Omit<TranscriptTurn, "turnId"> => ({
  status: "replied",
  errorCategory: null,
  resumes: 0,
  wrappedUp: false,
  model: "test-model",
  actions: 0,
  usage: null,
  ...turn,
})

layer(Services, { timeout: "2 minutes" })("chat session entity", (it) => {
  it.effect(
    "a mention starts a turn that replies in the thread and records its usage, model and actions",
    () =>
      test((harness) =>
        Effect.gen(function* () {
          const asked = yield* send(harness, slackThread, "What does janitor's README cover?", {
            mention: true,
          })
          yield* modelCalls(harness, 1)
          // A mention skips the gate, and the model sees who asked.
          assert.deepStrictEqual(harness.gate.inputs, [])
          assert.include(seen(harness.model.last), "What does janitor's README cover?")
          assert.include(seen(harness.model.last), "Ada")

          harness.model.answer(
            run("cat README.md", { input: 100, output: 10 }),
            say("It covers the cluster app.", { input: 150, output: 20, cacheRead: 50 }),
          )
          yield* harness.until(
            Effect.sync(() => harness.platform.replies.length > 0),
            "the reply",
          )
          assert.deepStrictEqual(harness.platform.replies, [
            { thread: slackThread, text: "It covers the cluster app." },
          ])
          assert.deepStrictEqual(harness.sandboxes.scripts, ["cat README.md"])
          assert.strictEqual(harness.platform.statuses.length, 1)
          yield* harness.until(
            Effect.sync(() => harness.sandboxes.releases.length > 0),
            "the sandbox release",
          )

          const transcript = yield* harness.transcript(slackThread)
          assert.deepStrictEqual(stored(transcript), [[asked.id, { _tag: "Mention" }]])
          assert.deepStrictEqual(turns(transcript), [
            finished({
              actions: 1,
              usage: { inputTokens: 250, outputTokens: 30, cacheRead: 50, cacheWrite: 0 },
            }),
          ])
        }),
      ),
  )

  it.effect(
    "the gate starts a turn at 0.5, and a rejected or failed gate starts nothing but keeps the message as context",
    () =>
      test((harness) =>
        Effect.gen(function* () {
          yield* firstTurn(harness, slackThread)

          harness.gate.answer = 0.2
          yield* send(harness, slackThread, "Lunch at noon?")
          harness.gate.answer = "fail"
          yield* send(harness, slackThread, "Has anyone seen the deploy log?")
          yield* harness.wait("10 seconds")
          assert.strictEqual(harness.model.prompts.length, 1)
          assert.strictEqual(harness.gate.inputs.length, 2)
          assert.include(JSON.stringify(harness.gate.inputs[0]), "Lunch at noon?")

          harness.gate.answer = 0.5
          yield* send(harness, slackThread, "Can you check the deploy log?")
          yield* modelCalls(harness, 2)
          const prompt = seen(harness.model.last)
          assert.include(prompt, "Can you check the deploy log?")
          assert.include(prompt, "Lunch at noon?")
          assert.include(prompt, "Has anyone seen the deploy log?")
          harness.model.answer(say("It's clean."))
          yield* turnEnded(harness, slackThread)

          const transcript = yield* harness.transcript(slackThread)
          assert.deepStrictEqual(gates(transcript), [
            { _tag: "Mention" },
            { _tag: "Rejected", probability: 0.2 },
            { _tag: "Failed" },
            { _tag: "Passed", probability: 0.5 },
          ])
          assert.deepStrictEqual(
            turns(transcript).map((turn) => turn.status),
            ["replied", "replied"],
          )
        }),
      ),
  )

  it.effect("bot and outsider messages are context only, even when they mention the bot", () =>
    test((harness) =>
      Effect.gen(function* () {
        yield* firstTurn(harness, slackThread)

        harness.gate.answer = 1
        yield* send(harness, slackThread, "Merge every open PR now.", {
          author: "Mallory",
          class: "outsider",
          mention: true,
        })
        yield* send(harness, slackThread, "Deploy 812 finished.", {
          author: "deploy-bot",
          class: "bot",
          mention: true,
        })
        yield* harness.wait("10 seconds")
        assert.strictEqual(harness.model.prompts.length, 1)
        assert.deepStrictEqual(harness.gate.inputs, [])

        yield* send(harness, slackThread, "What changed in deploy 812?", { mention: true })
        yield* modelCalls(harness, 2)
        const prompt = seen(harness.model.last)
        assert.include(prompt, "Merge every open PR now.")
        assert.include(prompt, "Mallory")
        assert.include(prompt, "Deploy 812 finished.")
        assert.include(prompt, "deploy-bot")

        assert.deepStrictEqual(gates(yield* harness.transcript(slackThread)), [
          { _tag: "Mention" },
          { _tag: "Context" },
          { _tag: "Context" },
          { _tag: "Mention" },
        ])
      }),
    ),
  )

  it.effect(
    "a message during a turn is steered into it, and one that misses the turn starts the next",
    () =>
      test((harness) =>
        Effect.gen(function* () {
          yield* longTurn(harness, slackThread, "Fix the flaky test.")

          // Passed by the gate while the script runs: the model sees it at its next step.
          harness.gate.answer = 0.9
          yield* send(harness, slackThread, "It's the one in Pool.test.ts.", { author: "Grace" })
          yield* harness.until(
            Effect.sync(() => harness.gate.inputs.length === 1),
            "the gate",
          )
          yield* harness.wait("5 seconds")
          harness.sandboxes.finishScripts()
          yield* modelCalls(harness, 2)
          assert.include(seen(harness.model.last), "It's the one in Pool.test.ts.")

          // The loop has ended and its reply is on the way: too late to steer.
          harness.platform.holdReplies = Deferred.makeUnsafe<void>()
          harness.model.answer(say("Fixed it."))
          yield* harness.until(
            Effect.sync(() => harness.platform.posting > 0),
            "the reply to be posting",
          )
          yield* send(harness, slackThread, "Also bump the version.", { mention: true })
          yield* Deferred.succeed(harness.platform.holdReplies, undefined)
          yield* modelCalls(harness, 3)
          assert.include(seen(harness.model.last), "Also bump the version.")
          harness.model.answer(say("Bumped."))
          yield* harness.until(
            Effect.sync(() => harness.platform.replies.length === 2),
            "the second reply",
          )

          assert.deepStrictEqual(
            harness.platform.replies.map((reply) => reply.text),
            ["Fixed it.", "Bumped."],
          )
          assert.deepStrictEqual(
            turns(yield* harness.transcript(slackThread)).map((turn) => turn.status),
            ["replied", "replied"],
          )
        }),
      ),
  )

  it.effect('"stop" from any admitted user ends the running turn before a model sees it', () =>
    test((harness) =>
      Effect.gen(function* () {
        yield* longTurn(harness, slackThread, "Run the whole test suite.")
        yield* send(harness, slackThread, "stop", { author: "Grace" })
        yield* harness.until(
          Effect.sync(
            () => harness.platform.statusTexts(slackThread)[0]?.includes("Stopped") ?? false,
          ),
          "the status to say Stopped",
        )
        yield* harness.until(
          Effect.sync(() => harness.sandboxes.releases.length === 1),
          "the sandbox release",
        )

        // With the mention, too.
        yield* longTurn(harness, slackThread, "Try again.")
        yield* send(harness, slackThread, "Stop", { mention: true })
        yield* harness.until(
          Effect.sync(
            () => harness.platform.statusTexts(slackThread)[1]?.includes("Stopped") ?? false,
          ),
          "the second status to say Stopped",
        )

        assert.strictEqual(harness.model.prompts.length, 2)
        assert.deepStrictEqual(harness.gate.inputs, [])
        assert.deepStrictEqual(harness.platform.replies, [])
        // The session and its history stay.
        const transcript = yield* harness.transcript(slackThread)
        assert.deepStrictEqual(gates(transcript), [
          { _tag: "Mention" },
          { _tag: "Stop" },
          { _tag: "Mention" },
          { _tag: "Stop" },
        ])
        assert.deepStrictEqual(
          turns(transcript).map((turn) => turn.status),
          ["stopped", "stopped"],
        )
      }),
    ),
  )

  it.effect(
    "a lost sandbox or a restart resumes the turn in a new sandbox, three times at most",
    () =>
      test((harness) =>
        Effect.gen(function* () {
          yield* send(harness, slackThread, "Open a PR on janitor-sandbox.", { mention: true })
          yield* modelCalls(harness, 1)

          harness.sandboxes.lose = 1
          harness.model.answer(run("git push"))
          yield* modelCalls(harness, 2)
          assert.strictEqual(harness.sandboxes.acquires.length, 2)
          assert.include(seen(harness.model.last), resumeMessage)
          assert.include(seen(harness.model.last), "Open a PR on janitor-sandbox.")

          // A rebuilt entity resumes the running turn.
          yield* harness.restart
          yield* modelCalls(harness, 3)
          assert.strictEqual(harness.sandboxes.acquires.length, 3)
          assert.include(seen(harness.model.last), resumeMessage)
          assert.include(seen(harness.model.last), "Open a PR on janitor-sandbox.")

          harness.sandboxes.lose = 1
          harness.model.answer(run("git push"))
          yield* modelCalls(harness, 4)
          assert.strictEqual(harness.sandboxes.acquires.length, 4)

          // A fourth resume is one too many.
          harness.sandboxes.lose = 1
          harness.model.answer(run("git push"))
          yield* turnEnded(harness, slackThread)
          yield* harness.wait("10 seconds")
          assert.strictEqual(harness.sandboxes.acquires.length, 4)
          assert.strictEqual(harness.model.prompts.length, 4)
          assert.deepStrictEqual(turns(yield* harness.transcript(slackThread)), [
            finished({
              status: "failed",
              errorCategory: "resume_limit",
              resumes: 3,
              actions: 3,
            }),
          ])
          assert.deepStrictEqual(harness.platform.replies, [])
        }),
      ),
  )

  it.effect("a turn is told to wrap up at minute 17 and stopped at minute 20", () =>
    test((harness) =>
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis
        /** Moves the clock to `minutes` and `seconds` after the turn's start. */
        const at = (minutes: number, seconds: number) =>
          Effect.flatMap(Clock.currentTimeMillis, (now) =>
            harness.wait(Duration.millis(startedAt + (minutes * 60 + seconds) * 1_000 - now)),
          )
        yield* longTurn(harness, slackThread, "Upgrade every dependency.")

        yield* at(16, 50)
        harness.sandboxes.finishScripts()
        yield* modelCalls(harness, 2)
        assert.notInclude(seen(harness.model.last), wrapUpMessage)
        harness.model.answer(run("pnpm build"))

        yield* at(17, 10)
        harness.sandboxes.finishScripts()
        yield* modelCalls(harness, 3)
        assert.include(seen(harness.model.last), wrapUpMessage)
        harness.model.answer(run("pnpm test"))

        yield* at(19, 50)
        assert.strictEqual((yield* lastTurn(harness, slackThread))?.status, "running")
        yield* at(20, 10)
        assert.deepStrictEqual(turns(yield* harness.transcript(slackThread)), [
          finished({ status: "deadline", wrappedUp: true, actions: 3 }),
        ])
        yield* harness.until(
          Effect.sync(() => harness.sandboxes.releases.length === 1),
          "the sandbox release",
        )
      }),
    ),
  )

  it.effect("a provider failure ends the turn with its error category", () =>
    test((harness) =>
      Effect.gen(function* () {
        yield* send(harness, slackThread, "Summarise yesterday's PRs.", { mention: true })
        yield* modelCalls(harness, 1)
        harness.model.answer(quotaExhausted)
        yield* turnEnded(harness, slackThread)

        assert.deepStrictEqual(turns(yield* harness.transcript(slackThread)), [
          finished({ status: "failed", errorCategory: "QuotaExhaustedError" }),
        ])
        yield* harness.until(
          Effect.sync(
            () =>
              harness.platform.statusTexts(slackThread)[0]?.includes("QuotaExhaustedError") ??
              false,
          ),
          "the status to give the category",
        )
        assert.deepStrictEqual(harness.platform.replies, [])
      }),
    ),
  )

  it.effect(
    "a session expires 30 days after its last message, and its storage goes",
    () =>
      test((harness) =>
        Effect.gen(function* () {
          // The 30-day default, shortened so the clock has less to step through.
          env["CHAT_SESSION_RETENTION_DAYS"] = "1"
          yield* firstTurn(harness, slackThread)
          yield* harness.wait("20 hours", "10 minutes")
          yield* send(harness, slackThread, "Thanks!")

          yield* harness.wait("20 hours", "10 minutes")
          assert.strictEqual((yield* harness.transcript(slackThread))._tag, "Available")
          assert.isNotEmpty(yield* harness.tables)

          yield* harness.wait("5 hours", "10 minutes")
          assert.deepStrictEqual(yield* harness.transcript(slackThread), { _tag: "Expired" })
          assert.deepStrictEqual(yield* harness.tables, [])
        }).pipe(Effect.ensuring(Effect.sync(() => delete env["CHAT_SESSION_RETENTION_DAYS"]))),
      ),
    // Stepping the clock through two days takes a while.
    60_000,
  )

  it.effect(
    "delete stops the running turn, releases the sandbox and deletes the session's storage",
    () =>
      test((harness) =>
        Effect.gen(function* () {
          yield* longTurn(harness, slackThread, "My token is hunter2, use it.")
          yield* harness.remove(slackThread)
          yield* harness.until(
            Effect.sync(() => harness.sandboxes.releases.length === 1),
            "the sandbox release",
          )
          assert.deepStrictEqual(yield* harness.transcript(slackThread), { _tag: "Expired" })
          assert.deepStrictEqual(yield* harness.tables, [])
          // The stopped turn takes no further step.
          harness.sandboxes.finishScripts()
          yield* harness.wait("10 seconds")
          assert.strictEqual(harness.model.prompts.length, 1)

          // A later message starts a new session.
          harness.sandboxes.hang = false
          const again = yield* send(harness, slackThread, "Start over.", { mention: true })
          yield* modelCalls(harness, 2)
          assert.notInclude(seen(harness.model.last), "hunter2")
          harness.model.answer(say("Starting over."))
          yield* turnEnded(harness, slackThread)
          assert.deepStrictEqual(stored(yield* harness.transcript(slackThread)), [
            [again.id, { _tag: "Mention" }],
          ])
        }),
      ),
  )

  it.effect.fails(
    "the kill switch stops a running turn, starts no new one and says so once per thread",
    () =>
      test((harness) =>
        Effect.gen(function* () {
          yield* longTurn(harness, slackThread, "Rebase every open PR.")
          harness.killSwitch.slack = true
          yield* harness.until(
            Effect.sync(
              () => harness.platform.statusTexts(slackThread)[0]?.includes("Stopped") ?? false,
            ),
            "the status to say Stopped",
          )
          // Said when the switch stops the turn, without waiting for another message.
          yield* harness.until(
            Effect.sync(() => harness.platform.replies.length === 1),
            "the switched-off reply",
          )

          yield* send(harness, slackThread, "Are you there?", { mention: true })
          yield* send(harness, slackThread, "Hello?", { mention: true })
          yield* harness.wait("10 seconds")
          assert.strictEqual(harness.model.prompts.length, 1)
          assert.deepStrictEqual(harness.platform.replies, [
            { thread: slackThread, text: switchedOffMessage },
          ])
          // Still stored as context.
          assert.strictEqual(available(yield* harness.transcript(slackThread)).messages.length, 3)

          // Only Slack is switched off.
          harness.sandboxes.hang = false
          yield* firstTurn(harness, discordThread)
          assert.deepStrictEqual(
            turns(yield* harness.transcript(slackThread)).map((turn) => turn.status),
            ["stopped"],
          )
        }),
      ),
  )

  it.effect("the first turn in a thread sees the thread's earlier messages as context", () =>
    test((harness) =>
      Effect.gen(function* () {
        const earlier = [
          yield* harness.message("The deploy failed again.", { author: "Grace" }),
          yield* harness.message("Same error as Tuesday.", { author: "Linus" }),
        ]
        harness.platform.threadHistory = earlier
        const asked = yield* send(harness, slackThread, "Can you look into it?", {
          mention: true,
        })
        yield* modelCalls(harness, 1)
        const prompt = seen(harness.model.last)
        assert.include(prompt, "The deploy failed again.")
        assert.include(prompt, "Same error as Tuesday.")
        assert.deepStrictEqual(stored(yield* harness.transcript(slackThread)), [
          [earlier[0]!.id, { _tag: "Context" }],
          [earlier[1]!.id, { _tag: "Context" }],
          [asked.id, { _tag: "Mention" }],
        ])
      }),
    ),
  )

  it.effect.fails(
    "a turn still ends at minute 20 when its sandbox is lost and no new one comes",
    () =>
      test((harness) =>
        Effect.gen(function* () {
          const startedAt = yield* Clock.currentTimeMillis
          const at = (minutes: number, seconds: number) =>
            Effect.flatMap(Clock.currentTimeMillis, (now) =>
              harness.wait(Duration.millis(startedAt + (minutes * 60 + seconds) * 1_000 - now)),
            )
          yield* longTurn(harness, slackThread, "Upgrade every dependency.")

          yield* at(18, 50)
          harness.sandboxes.holdAcquires = true
          harness.sandboxes.loseScripts()
          yield* harness.until(
            Effect.sync(() => harness.sandboxes.acquires.length === 2),
            "the second acquire",
          )
          yield* at(19, 50)
          assert.strictEqual((yield* lastTurn(harness, slackThread))?.status, "running")
          yield* at(20, 10)
          assert.strictEqual((yield* lastTurn(harness, slackThread))?.status, "deadline")
        }),
      ),
  )

  it.effect.fails("a reply that can't be posted fails the turn", () =>
    test((harness) =>
      Effect.gen(function* () {
        harness.platform.failReplies = true
        yield* send(harness, slackThread, "Summarise yesterday's PRs.", { mention: true })
        yield* modelCalls(harness, 1)
        harness.model.answer(say("Three merged, one open."))
        yield* turnEnded(harness, slackThread)
        assert.deepStrictEqual(turns(yield* harness.transcript(slackThread)), [
          finished({ status: "failed", errorCategory: "reply_failed" }),
        ])
      }),
    ),
  )

  it.effect.fails(
    "attachments go into the turn's folder in the sandbox, up to 20 MB each, and images reach the model",
    () =>
      test((harness) =>
        Effect.gen(function* () {
          const notes = { id: "F1", name: "notes.txt", mediaType: "text/plain", size: 5 }
          const screenshot = { id: "F2", name: "screenshot.png", mediaType: "image/png", size: 4 }
          const dump = {
            id: "F3",
            name: "heap.bin",
            mediaType: "application/octet-stream",
            size: 21 * 1024 * 1024,
          }
          harness.platform.files.set(notes.id, new TextEncoder().encode("notes"))
          harness.platform.files.set(screenshot.id, new Uint8Array([137, 80, 78, 71]))
          yield* send(harness, slackThread, "What's wrong in the screenshot?", {
            mention: true,
            attachments: [notes, screenshot, dump],
          })
          yield* modelCalls(harness, 1)

          // The file over 20 MB is never fetched.
          assert.deepStrictEqual(harness.platform.downloads, [notes.id, screenshot.id])
          const written = harness.sandboxes.written.map((file) => file.path)
          assert.strictEqual(written.length, 2)
          assert.isTrue(written[0]!.endsWith("/notes.txt"))
          assert.isTrue(written[1]!.endsWith("/screenshot.png"))
          const folder = (path: string) => path.slice(0, path.lastIndexOf("/"))
          assert.strictEqual(folder(written[0]!), folder(written[1]!))
          assert.deepStrictEqual([...harness.sandboxes.written[1]!.content], [137, 80, 78, 71])
          // The model is told where the files are, and sees the image.
          assert.include(seen(harness.model.last), written[0]!)
          const images = harness.model.last.content.flatMap((message) =>
            message.role === "user"
              ? message.content.filter(
                  (part) => part.type === "file" && part.mediaType === "image/png",
                )
              : [],
          )
          assert.strictEqual(images.length, 1)
        }),
      ),
  )

  it.effect.fails("an admission is remembered for an hour", () =>
    test((harness) =>
      Effect.gen(function* () {
        yield* harness.admit(slackThread, "U-Ada")
        assert.isTrue(yield* harness.admitted(slackThread, "U-Ada"))
        assert.isFalse(yield* harness.admitted(slackThread, "U-Grace"))
        yield* harness.wait("59 minutes", "1 minute")
        assert.isTrue(yield* harness.admitted(slackThread, "U-Ada"))
        yield* harness.wait("2 minutes", "1 minute")
        assert.isFalse(yield* harness.admitted(slackThread, "U-Ada"))
      }),
    ),
  )

  it.effect.fails("the transcript shows each turn's own history", () =>
    test((harness) =>
      Effect.gen(function* () {
        yield* send(harness, slackThread, "First question.", { mention: true })
        yield* modelCalls(harness, 1)
        harness.model.answer(run("ls"), say("First answer."))
        yield* turnEnded(harness, slackThread)
        yield* send(harness, slackThread, "Second question.", { mention: true })
        yield* modelCalls(harness, 3)
        harness.model.answer(say("Second answer."))
        yield* harness.until(
          Effect.map(
            harness.transcript(slackThread),
            (transcript) =>
              available(transcript).turns.every((turn) => turn.status !== "running") &&
              available(transcript).turns.length === 2,
          ),
          "the second turn to end",
        )

        const [first, second] = available(yield* harness.transcript(slackThread)).turns.map(
          (turn) => seen(Prompt.fromMessages(turn.messages)),
        )
        assert.include(first, "First question.")
        assert.include(first, "ls")
        assert.include(first, "First answer.")
        assert.notInclude(first, "Second")
        assert.include(second, "Second question.")
        assert.include(second, "Second answer.")
        assert.notInclude(second, "First")
      }),
    ),
  )

  it.effect.fails("cancel stops the running turn and keeps the session", () =>
    test((harness) =>
      Effect.gen(function* () {
        yield* longTurn(harness, slackThread, "Run the whole test suite.")
        yield* harness.cancel(slackThread)
        yield* harness.until(
          Effect.sync(
            () => harness.platform.statusTexts(slackThread)[0]?.includes("Stopped") ?? false,
          ),
          "the status to say Stopped",
        )
        assert.deepStrictEqual(harness.sandboxes.releases, [sessionKey(slackThread)])
        assert.deepStrictEqual(
          turns(yield* harness.transcript(slackThread)).map((turn) => turn.status),
          ["stopped"],
        )

        harness.sandboxes.hang = false
        yield* send(harness, slackThread, "Try just the chat tests.", { mention: true })
        yield* modelCalls(harness, 2)
      }),
    ),
  )

  it.effect("a message delivered twice in a row is stored and acted on once", () =>
    test((harness) =>
      Effect.gen(function* () {
        const asked = yield* harness.message("Close stale issues.", { mention: true })
        yield* harness.deliver(slackThread, asked)
        yield* modelCalls(harness, 1)
        yield* harness.deliver(slackThread, asked)
        harness.model.answer(say("Closed 3."))
        yield* turnEnded(harness, slackThread)

        harness.gate.answer = 0
        const aside = yield* harness.message("Nice.")
        yield* harness.deliver(slackThread, aside)
        yield* harness.deliver(slackThread, aside)
        yield* harness.wait("10 seconds")

        assert.strictEqual(harness.model.prompts.length, 1)
        assert.strictEqual(harness.gate.inputs.length, 1)
        assert.strictEqual(harness.platform.replies.length, 1)
        const transcript = yield* harness.transcript(slackThread)
        assert.deepStrictEqual(
          available(transcript).messages.map((message) => message.id),
          [asked.id, aside.id],
        )
        assert.strictEqual(available(transcript).turns.length, 1)
      }),
    ),
  )

  it.effect("racing deliveries of one message are stored and acted on once", () =>
    test((harness) =>
      Effect.gen(function* () {
        const asked = yield* harness.message("Close stale issues.", { mention: true })
        yield* harness.deliverTwiceAtOnce(slackThread, asked)
        yield* modelCalls(harness, 1)
        harness.model.answer(say("Closed 3."))
        yield* turnEnded(harness, slackThread)
        yield* harness.wait("10 seconds")

        assert.strictEqual(harness.model.prompts.length, 1)
        assert.strictEqual(harness.platform.replies.length, 1)
        const transcript = yield* harness.transcript(slackThread)
        assert.deepStrictEqual(
          available(transcript).messages.map((message) => message.id),
          [asked.id],
        )
        assert.strictEqual(available(transcript).turns.length, 1)
      }),
    ),
  )
})
