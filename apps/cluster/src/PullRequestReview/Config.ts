import * as Config from "effect/Config"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"

/**
 * Deployment-wide PR review settings (EFF-1652, EFF-1650, EFF-1929). Every
 * value has a default, and the only per-repository setting is the enable flag
 * in `Store.ts`.
 */

export const DEFAULT_MODEL = "openai/gpt-6.1-sol"

/** The reasoning efforts, sent as the request's `reasoning_effort`. */
export const ReasoningEffort = Schema.Literals([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
])
export type ReasoningEffort = typeof ReasoningEffort.Type

export interface PullRequestReviewConfig {
  /** `PR_REVIEW_AI_API_URL`: the OpenAI-compatible endpoint's base URL. Absent means PR review is off. */
  readonly apiUrl: Option.Option<string>
  /** `PR_REVIEW_AI_API_KEY`: the endpoint's API key. Absent means PR review is off. */
  readonly apiKey: Option.Option<Redacted.Redacted<string>>
  /** `PR_REVIEW_AI_MODEL`: the model the agent runs on, as the endpoint names it. */
  readonly model: string
  /** `PR_REVIEW_AI_REASONING_EFFORT`: the model's reasoning effort. */
  readonly reasoningEffort: ReasoningEffort
  /** `PR_REVIEW_AI_VIA_TAILNET`: reach the endpoint through the tailnet egress container. */
  readonly viaTailnet: boolean
  /** `PR_REVIEW_RUN_DEADLINE_SECONDS`: when a run is interrupted, counted from its first start and across resumes. */
  readonly runDeadline: Duration.Duration
  /** `PR_REVIEW_WRAP_UP_AFTER_SECONDS`: when the agent is told to wrap up, counted the same way. */
  readonly wrapUpAfter: Duration.Duration
  /** `PR_REVIEW_COMMAND_TIMEOUT_SECONDS`: the longest one `bash` command or `execute` script may run. */
  readonly commandTimeout: Duration.Duration
  /** `PR_REVIEW_MAX_CHANGED_LINES`: a pull request with more changed lines is oversized. */
  readonly maxChangedLines: number
  /** `PR_REVIEW_MAX_CHANGED_FILES`: a pull request with more changed files is oversized. */
  readonly maxChangedFiles: number
  /** `PR_REVIEW_MAX_INLINE_COMMENTS`: inline comments per review; the rest go in the body. */
  readonly maxInlineComments: number
  /** `PR_REVIEW_MAX_AUTOMATIC_RUNS`: automatic runs per pull request before `/janitor` is needed. */
  readonly maxAutomaticRuns: number
  /** `PR_REVIEW_MAX_RESUMES`: how often one run may resume after a restart or lost sandbox. */
  readonly maxResumes: number
  /** `PR_REVIEW_RUN_RETENTION_DAYS`: how long a final run entity keeps its debugging data. */
  readonly runRetention: Duration.Duration
  /** `PR_REVIEW_SCHEDULER_WIPE_DAYS`: how long after close the per-PR scheduler wipes itself. */
  readonly schedulerWipeAfterClose: Duration.Duration
  /** `PR_REVIEW_SENSITIVE_PATHS`: comma-separated globs an author without write access can't get approved. */
  readonly sensitivePaths: ReadonlyArray<string>
  /** `PR_REVIEW_LOCKFILES`: comma-separated lockfile names; any change to one is a dependency change. */
  readonly lockfiles: ReadonlyArray<string>
  /** `PR_REVIEW_MANIFESTS`: comma-separated manifest names whose dependency sections are sensitive. */
  readonly manifests: ReadonlyArray<string>
}

const Positive = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2147483647 }))

const count = (name: string, fallback: number) =>
  Config.schema(Positive, name).pipe(Config.withDefault(fallback))

const seconds = (name: string, fallback: number) =>
  count(name, fallback).pipe(Config.map(Duration.seconds))

const days = (name: string, fallback: number) =>
  count(name, fallback).pipe(Config.map(Duration.days))

const names = (name: string, fallback: ReadonlyArray<string>) =>
  Config.Array(Schema.NonEmptyString, name).pipe(Config.withDefault(fallback))

const ReviewTiming = Schema.Struct({
  runDeadline: Schema.Duration,
  wrapUpAfter: Schema.Duration,
  commandTimeout: Schema.Duration,
}).check(
  Schema.makeFilter(
    ({ runDeadline, wrapUpAfter }) => Duration.isLessThan(wrapUpAfter, runDeadline),
    { expected: "PR_REVIEW_WRAP_UP_AFTER_SECONDS < PR_REVIEW_RUN_DEADLINE_SECONDS" },
  ),
  Schema.makeFilter(
    ({ runDeadline, wrapUpAfter, commandTimeout }) =>
      Duration.isLessThanOrEqualTo(commandTimeout, Duration.subtract(runDeadline, wrapUpAfter)),
    {
      expected:
        "PR_REVIEW_COMMAND_TIMEOUT_SECONDS <= PR_REVIEW_RUN_DEADLINE_SECONDS - PR_REVIEW_WRAP_UP_AFTER_SECONDS",
    },
  ),
)

/**
 * `PR_REVIEW_SANDBOX_MAX_INSTANCES`: how many sandbox containers may run at
 * once, one per active run. Read when the container application deploys.
 */
export const sandboxMaxInstances: Config.Config<number> = count(
  "PR_REVIEW_SANDBOX_MAX_INSTANCES",
  20,
)

/**
 * `PR_REVIEW_COMMAND_TIMEOUT_SECONDS` alone, for the sandbox container: it
 * caps each command and script in the executor it serves. The container's
 * image carries it from the deploy.
 */
export const sandboxCommandTimeout: Config.Config<Duration.Duration> = seconds(
  "PR_REVIEW_COMMAND_TIMEOUT_SECONDS",
  300,
)

const apiUrl = Config.option(Config.NonEmptyString("PR_REVIEW_AI_API_URL"))

const apiKey = Config.option(Config.Redacted("PR_REVIEW_AI_API_KEY"))

/**
 * The deployment-wide gate alone: PR review is on while both
 * `PR_REVIEW_AI_API_URL` and `PR_REVIEW_AI_API_KEY` are set. The webhook hooks
 * read just this, so a bad PR review setting can't fail the projection
 * labeling shares.
 */
export const pullRequestReviewGate: Config.Config<boolean> = Config.all({ apiUrl, apiKey }).pipe(
  Config.map(({ apiUrl, apiKey }) => Option.isSome(apiUrl) && Option.isSome(apiKey)),
)

const model = Config.NonEmptyString("PR_REVIEW_AI_MODEL").pipe(Config.withDefault(DEFAULT_MODEL))

const reasoningEffort = Config.schema(ReasoningEffort, "PR_REVIEW_AI_REASONING_EFFORT").pipe(
  Config.withDefault("medium" as const),
)

const viaTailnet = Config.Boolean("PR_REVIEW_AI_VIA_TAILNET").pipe(Config.withDefault(false))

/**
 * What the tailnet egress container is deployed with (docs/pr-review.md):
 * the Tailscale credential and tags it joins with, and the one origin it
 * forwards to, the endpoint's. Read when the container application deploys.
 * Without `TAILSCALE_AUTH_KEY` the container has no credential and never
 * starts; `PR_REVIEW_AI_VIA_TAILNET` stays off then.
 */
export const tailnetEgressConfig = Config.all({
  /** `TAILSCALE_AUTH_KEY`: an OAuth client secret limited to minting keys for the tags. */
  authKey: Config.option(Config.Redacted("TAILSCALE_AUTH_KEY")),
  /** `TAILSCALE_TAGS`: comma-separated tags the node advertises. */
  tags: names("TAILSCALE_TAGS", ["tag:janitor-prod"]),
  upstreamOrigin: apiUrl.pipe(
    Config.map(Option.flatMap((url) => Option.liftThrowable(() => new URL(url).origin)())),
  ),
})

/**
 * What the web app shows about the deployment: whether PR review is
 * available, and the model and effort it runs on.
 */
export const pullRequestReviewDeployment = Config.all({
  available: pullRequestReviewGate,
  model,
  reasoningEffort,
})

export const pullRequestReviewConfig: Config.Config<PullRequestReviewConfig> = Config.all({
  apiUrl,
  apiKey,
  model,
  reasoningEffort,
  viaTailnet,
  runDeadline: seconds("PR_REVIEW_RUN_DEADLINE_SECONDS", 900),
  wrapUpAfter: seconds("PR_REVIEW_WRAP_UP_AFTER_SECONDS", 600),
  commandTimeout: sandboxCommandTimeout,
  maxChangedLines: count("PR_REVIEW_MAX_CHANGED_LINES", 10000),
  maxChangedFiles: count("PR_REVIEW_MAX_CHANGED_FILES", 100),
  maxInlineComments: count("PR_REVIEW_MAX_INLINE_COMMENTS", 25),
  maxAutomaticRuns: count("PR_REVIEW_MAX_AUTOMATIC_RUNS", 10),
  maxResumes: count("PR_REVIEW_MAX_RESUMES", 3),
  runRetention: days("PR_REVIEW_RUN_RETENTION_DAYS", 14),
  schedulerWipeAfterClose: days("PR_REVIEW_SCHEDULER_WIPE_DAYS", 30),
  sensitivePaths: names("PR_REVIEW_SENSITIVE_PATHS", [".github/**", "AGENTS.md", ".agents/**"]),
  lockfiles: names("PR_REVIEW_LOCKFILES", [
    "pnpm-lock.yaml",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
    "deno.lock",
  ]),
  manifests: names("PR_REVIEW_MANIFESTS", ["package.json"]),
}).pipe(
  Config.mapEffect((config) =>
    Schema.decodeEffect(ReviewTiming)(config).pipe(
      Effect.as(config),
      Effect.mapError((error) => new Config.ConfigError(error)),
    ),
  ),
)

/**
 * Reads every PR review setting the cluster Worker uses, for the Worker's
 * init. Alchemy binds only the config a Worker reads during init into its
 * deployed environment, and the cluster reads these later, so without this
 * read the deployed Worker never sees them. Never fails: an invalid setting
 * still fails the review model's calls, as `ReviewModelLayer` does.
 */
export const pullRequestReviewInit: Effect.Effect<void> = Effect.ignore(pullRequestReviewConfig)
