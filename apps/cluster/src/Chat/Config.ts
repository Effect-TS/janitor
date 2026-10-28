import * as Config from "effect/Config"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as GitHubAppAuth from "../GitHub/AppAuth.ts"
import { ReasoningEffort } from "../PullRequestReview/Config.ts"

/**
 * Deployment-wide chat bot settings (EFF-3015). Every value has a default.
 */

const Positive = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2147483647 }))

const count = (name: string, fallback: number) =>
  Config.schema(Positive, name).pipe(Config.withDefault(fallback))

const seconds = (name: string, fallback: number) =>
  count(name, fallback).pipe(Config.map(Duration.seconds))

/**
 * `CHAT_SANDBOX_MAX_INSTANCES`: how many chat sandbox containers may run at
 * once. A class of its own, so chat can't starve PR review. Read when the
 * container application deploys.
 */
export const chatSandboxMaxInstances: Config.Config<number> = count(
  "CHAT_SANDBOX_MAX_INSTANCES",
  10,
)

/**
 * `CHAT_COMMAND_TIMEOUT_SECONDS`: the longest one `bash` command or `execute`
 * script may run. The container's image carries it from the deploy.
 */
export const chatCommandTimeout: Config.Config<Duration.Duration> = seconds(
  "CHAT_COMMAND_TIMEOUT_SECONDS",
  300,
)

/** The Multica workspace the bot is a member of: Effectful's. */
const DEFAULT_MULTICA_WORKSPACE_ID = "6eac4221-824e-4b2f-8517-546454766676"

/**
 * `CHAT_MULTICA_WORKSPACE_ID`: the Multica workspace the sandbox's `multica`
 * CLI acts in.
 */
export const chatMulticaWorkspaceId: Config.Config<string> = Config.NonEmptyString(
  "CHAT_MULTICA_WORKSPACE_ID",
).pipe(Config.withDefault(DEFAULT_MULTICA_WORKSPACE_ID))

/** The Multica workspace's slug: Effectful's. A slug can't change after creation. */
const DEFAULT_MULTICA_WORKSPACE_SLUG = "tim-smart-f28a5191"

/**
 * `CHAT_MULTICA_WORKSPACE_SLUG`: the slug of the `CHAT_MULTICA_WORKSPACE_ID`
 * workspace, for the issue links the bot posts.
 */
export const chatMulticaWorkspaceSlug: Config.Config<string> = Config.NonEmptyString(
  "CHAT_MULTICA_WORKSPACE_SLUG",
).pipe(Config.withDefault(DEFAULT_MULTICA_WORKSPACE_SLUG))

/**
 * `CHAT_SANDBOX_WARM_SECONDS`: how long a session's sandbox stays warm after
 * its turn ends, so the next turn finds its clones and edits.
 */
export const chatSandboxWarm: Config.Config<Duration.Duration> = seconds(
  "CHAT_SANDBOX_WARM_SECONDS",
  1800,
)

/**
 * `CHAT_QUEUE_TIMEOUT_SECONDS`: how long a turn waits for a sandbox when every
 * one is running a turn, before it gives up as busy.
 */
export const chatQueueTimeout: Config.Config<Duration.Duration> = seconds(
  "CHAT_QUEUE_TIMEOUT_SECONDS",
  900,
)

/**
 * `CHAT_TURN_DEADLINE_SECONDS`: a turn's hard deadline, counted from its
 * start and across resumes.
 */
export const chatTurnDeadline: Config.Config<Duration.Duration> = seconds(
  "CHAT_TURN_DEADLINE_SECONDS",
  1200,
)

/**
 * `CHAT_WRAP_UP_AFTER_SECONDS`: when a turn is told to wrap up, counted from
 * its start like the deadline.
 */
export const chatWrapUpAfter: Config.Config<Duration.Duration> = seconds(
  "CHAT_WRAP_UP_AFTER_SECONDS",
  1020,
)

/** How long past the turn deadline the pool waits for a release before taking the turn as dead. */
const ABANDON_MARGIN = Duration.minutes(5)

/** The chat sandbox settings the Worker and its Durable Objects read at runtime. */
export const chatSandboxConfig = Config.all({
  maxInstances: chatSandboxMaxInstances,
  warmFor: chatSandboxWarm,
  queueTimeout: chatQueueTimeout,
  abandonAfter: chatTurnDeadline.pipe(
    Config.map((deadline) => Duration.sum(deadline, ABANDON_MARGIN)),
  ),
  multicaWorkspaceId: chatMulticaWorkspaceId,
})

/**
 * Reads the chat sandbox settings for the Worker's init, so alchemy binds
 * them into the deployed environment (as `pullRequestReviewInit` does).
 * Never fails: every setting has a default.
 */
export const chatSandboxInit: Effect.Effect<void> = Effect.ignore(chatSandboxConfig)

/** The chat bot's secrets. Each is optional, so the deployment runs before they exist. */
export interface ChatEgressSecrets {
  /** `CHAT_GITHUB_APP_ID` and `CHAT_GITHUB_APP_PRIVATE_KEY`: the bot's own GitHub App. */
  readonly app: Option.Option<GitHubAppAuth.GitHubAppCredentials>
  /** `CHAT_MULTICA_TOKEN`: the Janitor Multica user's PAT. */
  readonly multicaToken: Option.Option<Redacted.Redacted<string>>
}

/**
 * The chat egress proxy's secrets (EFF-3017). The Worker reads them at init,
 * so alchemy binds whichever are set.
 */
export const chatEgressSecrets: Config.Config<ChatEgressSecrets> = Config.all({
  app: Config.option(
    Config.unwrap(
      GitHubAppAuth.config({
        appId: "CHAT_GITHUB_APP_ID",
        privateKey: "CHAT_GITHUB_APP_PRIVATE_KEY",
      }),
    ),
  ),
  multicaToken: Config.option(Config.Redacted("CHAT_MULTICA_TOKEN")),
})

const chatAiApiUrl = Config.option(Config.NonEmptyString("CHAT_AI_API_URL"))

const chatAiApiKey = Config.option(Config.Redacted("CHAT_AI_API_KEY"))

/**
 * The deployment-wide gate (EFF-3018): the chat bot is on while both
 * `CHAT_AI_API_URL` and `CHAT_AI_API_KEY` are set. With either unset, the
 * Worker reads no other chat setting and binds no chat session.
 */
export const chatBotGate: Config.Config<boolean> = Config.all({
  apiUrl: chatAiApiUrl,
  apiKey: chatAiApiKey,
}).pipe(Config.map(({ apiUrl, apiKey }) => Option.isSome(apiUrl) && Option.isSome(apiKey)))

export const DEFAULT_CHAT_MODEL = "openai/gpt-6.1-sol"

/** The default reply gate model: Jev, as labeling uses (ADR 0013). */
export const DEFAULT_CHAT_GATE_MODEL = "typesafe/jev-1.13"

/** The chat model's settings, the same mechanism as PR review's with its own key. */
export const chatModelConfig = Config.all({
  /** `CHAT_AI_API_URL`: the OpenAI-compatible endpoint's base URL. */
  apiUrl: chatAiApiUrl,
  /** `CHAT_AI_API_KEY`: the endpoint's API key, separate from PR review's. */
  apiKey: chatAiApiKey,
  /** `CHAT_AI_MODEL`: the model turns run on. */
  model: Config.NonEmptyString("CHAT_AI_MODEL").pipe(Config.withDefault(DEFAULT_CHAT_MODEL)),
  /** `CHAT_AI_SUBAGENT_MODEL`: the model sub-agents run on; the turn's model when unset. */
  subagentModel: Config.option(Config.NonEmptyString("CHAT_AI_SUBAGENT_MODEL")),
  /** `CHAT_AI_REASONING_EFFORT`: the model's reasoning effort. */
  reasoningEffort: Config.schema(ReasoningEffort, "CHAT_AI_REASONING_EFFORT").pipe(
    Config.withDefault("medium" as const),
  ),
  /** `CHAT_AI_VIA_TAILNET`: reach the endpoint through the tailnet egress container. */
  viaTailnet: Config.Boolean("CHAT_AI_VIA_TAILNET").pipe(Config.withDefault(false)),
})

/** `CHAT_GATE_MODEL`: the reply gate's decision model on OpenRouter. */
export const chatGateModel: Config.Config<string> = Config.NonEmptyString("CHAT_GATE_MODEL").pipe(
  Config.withDefault(DEFAULT_CHAT_GATE_MODEL),
)

/** The settings a chat session reads while it runs turns. */
export const chatSessionConfig = Config.all({
  deadline: chatTurnDeadline,
  wrapUpAfter: chatWrapUpAfter,
  /** `CHAT_MAX_RESUMES`: how often one turn may resume after a lost sandbox or a restart. */
  maxResumes: Config.schema(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
    "CHAT_MAX_RESUMES",
  ).pipe(Config.withDefault(3)),
  /** `CHAT_SESSION_RETENTION_DAYS`: how long a session is kept after its last message. */
  retention: count("CHAT_SESSION_RETENTION_DAYS", 30).pipe(Config.map(Duration.days)),
  /** `PUBLIC_ORIGIN`: the web app, for the status message's transcript link. */
  publicOrigin: Config.option(Config.NonEmptyString("PUBLIC_ORIGIN")),
  multicaWorkspaceSlug: chatMulticaWorkspaceSlug,
})

/**
 * Reads the chat bot's model and gate settings for the Worker's init, so
 * alchemy binds them. Never fails: a bad setting fails the model's calls.
 */
export const chatBotInit: Effect.Effect<void> = Effect.ignore(
  Config.all([chatModelConfig, chatGateModel, chatSessionConfig]),
)
