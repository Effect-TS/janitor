import { assert, describe, it } from "@effect/vitest"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import {
  pullRequestReviewConfig,
  pullRequestReviewGate,
  pullRequestReviewInit,
} from "../../src/PullRequestReview/Config.ts"

const read = (values: Record<string, string>) =>
  pullRequestReviewConfig.pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(values))),
  )

/** The config with its durations in the units its variables use, for comparison. */
const plain = (config: Effect.Success<ReturnType<typeof read>>) => ({
  ...config,
  apiKey: Option.map(config.apiKey, Redacted.value),
  runDeadline: Duration.toSeconds(config.runDeadline),
  wrapUpAfter: Duration.toSeconds(config.wrapUpAfter),
  commandTimeout: Duration.toSeconds(config.commandTimeout),
  runRetention: Duration.toDays(config.runRetention),
  schedulerWipeAfterClose: Duration.toDays(config.schedulerWipeAfterClose),
})

describe("PR review configuration", () => {
  it.effect("is off without an API URL and key and applies the planned defaults", () =>
    Effect.gen(function* () {
      const config = plain(yield* read({}))
      assert.isTrue(Option.isNone(config.apiUrl))
      assert.isTrue(Option.isNone(config.apiKey))
      assert.deepInclude(config, {
        model: "openai/gpt-6.1-sol",
        reasoningEffort: "medium",
        runDeadline: 600,
        wrapUpAfter: 420,
        commandTimeout: 180,
        maxChangedLines: 10000,
        maxChangedFiles: 100,
        maxInlineComments: 25,
        maxAutomaticRuns: 10,
        maxResumes: 3,
        runRetention: 14,
        schedulerWipeAfterClose: 30,
        sensitivePaths: [".github/**", "AGENTS.md", ".agents/**"],
      })
      assert.include(config.lockfiles, "pnpm-lock.yaml")
      assert.include(config.manifests, "package.json")
    }),
  )

  it.effect("reads every setting from its PR_REVIEW_ variable", () =>
    Effect.gen(function* () {
      const config = plain(
        yield* read({
          PR_REVIEW_AI_API_URL: "https://ai.example.com/v1",
          PR_REVIEW_AI_API_KEY: "sk-test",
          PR_REVIEW_AI_MODEL: "anthropic/claude-opus-5-5",
          PR_REVIEW_AI_REASONING_EFFORT: "high",
          PR_REVIEW_RUN_DEADLINE_SECONDS: "900",
          PR_REVIEW_WRAP_UP_AFTER_SECONDS: "600",
          PR_REVIEW_COMMAND_TIMEOUT_SECONDS: "120",
          PR_REVIEW_MAX_CHANGED_LINES: "5000",
          PR_REVIEW_MAX_CHANGED_FILES: "50",
          PR_REVIEW_MAX_INLINE_COMMENTS: "20",
          PR_REVIEW_MAX_AUTOMATIC_RUNS: "5",
          PR_REVIEW_MAX_RESUMES: "1",
          PR_REVIEW_RUN_RETENTION_DAYS: "7",
          PR_REVIEW_SCHEDULER_WIPE_DAYS: "60",
          PR_REVIEW_SENSITIVE_PATHS: ".github/**,CODEOWNERS",
          PR_REVIEW_LOCKFILES: "pnpm-lock.yaml,Cargo.lock",
          PR_REVIEW_MANIFESTS: "package.json,Cargo.toml",
        }),
      )
      assert.deepStrictEqual(config, {
        apiUrl: Option.some("https://ai.example.com/v1"),
        apiKey: Option.some("sk-test"),
        model: "anthropic/claude-opus-5-5",
        reasoningEffort: "high",
        runDeadline: 900,
        wrapUpAfter: 600,
        commandTimeout: 120,
        maxChangedLines: 5000,
        maxChangedFiles: 50,
        maxInlineComments: 20,
        maxAutomaticRuns: 5,
        maxResumes: 1,
        runRetention: 7,
        schedulerWipeAfterClose: 60,
        sensitivePaths: [".github/**", "CODEOWNERS"],
        lockfiles: ["pnpm-lock.yaml", "Cargo.lock"],
        manifests: ["package.json", "Cargo.toml"],
      })
    }),
  )

  it.effect("gates PR review on both the API URL and the API key", () =>
    Effect.gen(function* () {
      const gate = (values: Record<string, string>) =>
        pullRequestReviewGate.pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(values))),
        )
      const url = { PR_REVIEW_AI_API_URL: "https://ai.test/v1" }
      const key = { PR_REVIEW_AI_API_KEY: "test-key" }
      assert.isFalse(yield* gate({}))
      assert.isFalse(yield* gate(url))
      assert.isFalse(yield* gate(key))
      assert.isTrue(yield* gate({ ...url, ...key }))
    }),
  )

  it.effect("rejects limits that leave no wrap-up window for the last command", () =>
    Effect.gen(function* () {
      for (const values of [
        { PR_REVIEW_WRAP_UP_AFTER_SECONDS: "600" },
        { PR_REVIEW_RUN_DEADLINE_SECONDS: "300" },
        { PR_REVIEW_COMMAND_TIMEOUT_SECONDS: "181" },
      ]) {
        const error = yield* Effect.flip(read(values))
        assert.strictEqual(error._tag, "ConfigError", Object.keys(values).join())
      }
    }),
  )

  it.effect("reads every setting at Worker init, so the deploy binds it, even an invalid one", () =>
    Effect.gen(function* () {
      // Every setting the cluster Worker reads, as the operator doc lists them. The
      // reasoning effort is invalid and comes early, so the rest must still be read.
      const values: Record<string, string> = {
        PR_REVIEW_AI_API_URL: "https://ai.test/v1",
        PR_REVIEW_AI_API_KEY: "test-key",
        PR_REVIEW_AI_MODEL: "openai/gpt-6.1-sol",
        PR_REVIEW_AI_REASONING_EFFORT: "loud",
        PR_REVIEW_RUN_DEADLINE_SECONDS: "600",
        PR_REVIEW_WRAP_UP_AFTER_SECONDS: "420",
        PR_REVIEW_COMMAND_TIMEOUT_SECONDS: "180",
        PR_REVIEW_MAX_CHANGED_LINES: "10000",
        PR_REVIEW_MAX_CHANGED_FILES: "100",
        PR_REVIEW_MAX_INLINE_COMMENTS: "25",
        PR_REVIEW_MAX_AUTOMATIC_RUNS: "10",
        PR_REVIEW_MAX_RESUMES: "3",
        PR_REVIEW_RUN_RETENTION_DAYS: "14",
        PR_REVIEW_SCHEDULER_WIPE_DAYS: "30",
        PR_REVIEW_SENSITIVE_PATHS: ".github/**",
        PR_REVIEW_LOCKFILES: "pnpm-lock.yaml",
        PR_REVIEW_MANIFESTS: "package.json",
      }
      const source = ConfigProvider.fromUnknown(values)
      const read = new Set<string>()
      const recording = ConfigProvider.make((path) => {
        read.add(String(path[0]))
        return source.load(path)
      })

      yield* pullRequestReviewInit.pipe(Effect.provide(ConfigProvider.layer(recording)))

      assert.includeMembers([...read], Object.keys(values))
    }),
  )
})
