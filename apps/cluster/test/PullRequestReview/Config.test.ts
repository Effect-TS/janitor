import { assert, describe, it } from "@effect/vitest"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import { pullRequestReviewConfig } from "../../src/PullRequestReview/Config.ts"

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
  it.effect("is off without an API key and applies the planned defaults", () =>
    Effect.gen(function* () {
      const config = plain(yield* read({}))
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
          PR_REVIEW_OPENROUTER_API_KEY: "sk-or-test",
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
        apiKey: Option.some("sk-or-test"),
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
})
