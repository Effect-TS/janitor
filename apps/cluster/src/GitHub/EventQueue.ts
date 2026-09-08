import type { GitHubWebhookDeliveryId } from "@janitor/domain/GitHub/Id"
import { GitHubWebhookEnvelopeV1 } from "@janitor/domain/GitHub/WebhookEnvelope"
import type { RuntimeContext } from "alchemy/RuntimeContext"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

/** Signed, encrypted webhook envelopes awaiting the journal consumer. */
export const GitHubEventsQueue = Cloudflare.Queues.Queue("GitHubEventsQueue")

/** Envelopes the consumer could not journal, with content-safe diagnostics. */
export const GitHubEventsDeadLetterQueue = Cloudflare.Queues.Queue("GitHubEventsDeadLetterQueue")

export class EnqueueError extends Data.TaggedError("EnqueueError")<{
  readonly deliveryId: GitHubWebhookDeliveryId
  readonly cause: unknown
}> {}

export class GitHubEventQueue extends Context.Service<
  GitHubEventQueue,
  {
    readonly enqueue: (
      envelope: GitHubWebhookEnvelopeV1,
    ) => Effect.Effect<void, EnqueueError, RuntimeContext>
  }
>()("@janitor/cluster/GitHub/EventQueue/GitHubEventQueue") {}

const make = Effect.gen(function* () {
  const resource = yield* GitHubEventsQueue
  const queue = yield* Cloudflare.Queues.WriteQueue(resource)

  const encodeEnvelope = Schema.encodeEffect(GitHubWebhookEnvelopeV1)

  const enqueue = Effect.fn("GitHubEventQueue.enqueue")(
    function* (envelope: GitHubWebhookEnvelopeV1) {
      const body = yield* encodeEnvelope(envelope)
      return yield* queue.send(body, { contentType: "json" })
    },
    (effect, envelope) =>
      Effect.mapError(
        effect,
        (cause) => new EnqueueError({ deliveryId: envelope.deliveryId, cause }),
      ),
  )

  return {
    enqueue,
  }
})

export const layer = Layer.effect(GitHubEventQueue, make)
