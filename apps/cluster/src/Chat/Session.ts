import type * as CloudflareCluster from "@effect/platform-cloudflare/CloudflareCluster"
import type * as DecisionModel from "effect/ai/DecisionModel"
import type * as LanguageModel from "effect/ai/LanguageModel"
import type * as Model from "effect/ai/Model"
import * as ClusterSchema from "effect/cluster/ClusterSchema"
import * as Entity from "effect/cluster/Entity"
import type * as Sharding from "effect/cluster/Sharding"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Rpc from "effect/rpc/Rpc"
import * as RpcGroup from "effect/rpc/RpcGroup"
import * as Schema from "effect/Schema"
import type { ChatKillSwitch } from "./KillSwitch.ts"
import { ChatMessage, type ChatPlatform, ChatThread } from "./Platform.ts"
import type { ChatSandboxes } from "./Sandbox/Sandboxes.ts"

/**
 * The chat session entity (EFF-3018): one per chat thread, with the session
 * key as its entity id. It stores the thread's messages, runs the reply gate
 * and runs the thread's turns.
 */

/**
 * A thread message from ingress. The session stores it once, keyed by its
 * platform message id, then gates it, steers it into the running turn,
 * starts a turn with it or keeps it as context.
 */
export const Receive = Rpc.make("Receive", {
  payload: { thread: ChatThread, message: ChatMessage },
  primaryKey: ({ message }) => `receive/${message.id}`,
})

/**
 * Deletes the session early, from the web app: cancels a running turn,
 * releases the sandbox and deletes the session's storage. A later message
 * starts a new session.
 */
export const Delete = Rpc.make("Delete", { payload: {} })

/** What the reply gate made of a message, for the transcript. */
export const GateOutcome = Schema.TaggedUnion({
  /** It mentions the bot, so it skipped the gate. */
  Mention: {},
  /** Only "stop": it cancelled the running turn before any model saw it. */
  Stop: {},
  Passed: { probability: Schema.Finite },
  Rejected: { probability: Schema.Finite },
  /** The gate call failed, so it started nothing. */
  Failed: {},
  /** From an outsider or a bot: never gated, context only. */
  Context: {},
})
export type GateOutcome = typeof GateOutcome.Type

/** A turn's final cumulative clanka `Usage`, sub-agents included. */
export const TurnUsage = Schema.Struct({
  inputTokens: Schema.Int,
  outputTokens: Schema.Int,
  cacheRead: Schema.Int,
  cacheWrite: Schema.Int,
})

export const TurnStatus = Schema.Literals([
  "running",
  /** Ended with a final reply. */
  "replied",
  /** "stop", the kill switch or a delete. */
  "stopped",
  "deadline",
  "failed",
])

export const TranscriptTurn = Schema.Struct({
  turnId: Schema.String,
  status: TurnStatus,
  /** Why a failed turn failed: a provider error's category, or `resume_limit`. */
  errorCategory: Schema.NullOr(Schema.String),
  resumes: Schema.Int,
  wrappedUp: Schema.Boolean,
  model: Schema.NullOr(Schema.String),
  /** How many scripts the turn started, across its resumes. */
  actions: Schema.Int,
  /** Null until the model reports any. */
  usage: Schema.NullOr(TurnUsage),
})
export type TranscriptTurn = typeof TranscriptTurn.Type

/** What the session's storage holds: nothing once it expired or was deleted. */
export const TranscriptResult = Schema.TaggedUnion({
  Expired: {},
  Available: {
    messages: Schema.Array(Schema.Struct({ ...ChatMessage.fields, gate: GateOutcome })),
    turns: Schema.Array(TranscriptTurn),
  },
})
export type TranscriptResult = typeof TranscriptResult.Type

/** Reads the session's transcript as committed so far. */
export const Transcript = Rpc.make("Transcript", { success: TranscriptResult })

export const ChatSession = Entity.fromRpcGroup(
  "ChatSession",
  RpcGroup.make(Receive, Delete)
    .annotateRpcs(ClusterSchema.Persisted, true)
    // A read changes nothing, so it isn't stored and replayed like the rest.
    .add(Transcript),
)

/**
 * The session entity's handlers, over its own Durable Object SQLite. The
 * turn's agent is clanka on the `CHAT_AI_*` model, and the reply gate is
 * Jev through its own `DecisionModel`.
 */
export const ChatSessionLayer: Layer.Layer<
  never,
  never,
  | ChatPlatform
  | ChatSandboxes
  | ChatKillSwitch
  | LanguageModel.LanguageModel
  | Model.ProviderName
  | Model.ModelName
  | DecisionModel.DecisionModel
  | CloudflareCluster.DurableObjectSqlClient
  | Sharding.Sharding
> = ChatSession.toLayer(Effect.die("the chat session entity is not implemented yet (EFF-3018)"))
