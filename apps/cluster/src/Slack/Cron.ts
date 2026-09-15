import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Singleton from "effect/unstable/cluster/Singleton"
import { SlackProcessor } from "./Processor.ts"
import { SlackDelivery } from "./Delivery.ts"
import { GitHubFeedback } from "../GitHub/Feedback.ts"
import { GitHubDelivery } from "../GitHub/FeedbackDelivery.ts"
import { flushLive } from "../LiveUpdates.ts"

export const SlackCronName = "slack-conversations"
export const SlackCronLayer = Singleton.make(
  SlackCronName,
  Effect.gen(function* () {
    const delivery = yield* SlackDelivery
    const feedback = yield* GitHubFeedback
    const github = yield* GitHubDelivery
    const started = yield* Clock.currentTimeMillis
    // Durable rows survive missed wakes; the minute cron always restarts discovery.
    while ((yield* Clock.currentTimeMillis) - started < 50_000) {
      yield* feedback.processDue.pipe(
        Effect.catchCause((cause) => Effect.logError("GitHub feedback hydration failed", cause)),
      )
      yield* delivery.processDue.pipe(
        Effect.catchCause((cause) => Effect.logError("Slack publication failed", cause)),
      )
      yield* github.processDue.pipe(
        Effect.catchCause((cause) => Effect.logError("GitHub feedback publication failed", cause)),
      )
      // Delivery health and associations changed above commit their invalidation intent.
      yield* flushLive
      yield* Effect.sleep(1000)
    }
  }),
)

// Sending does not wait for repository setup or runner reads.
export const SlackDeliveryCronName = "slack-delivery"
export const SlackDeliveryCronLayer = Singleton.make(
  SlackDeliveryCronName,
  Effect.gen(function* () {
    const delivery = yield* SlackDelivery
    const started = yield* Clock.currentTimeMillis
    while ((yield* Clock.currentTimeMillis) - started < 50_000) {
      yield* delivery.sendDue.pipe(
        Effect.catchCause((cause) => Effect.logError("Slack sending failed", cause)),
      )
      yield* Effect.sleep(1000)
    }
  }),
)

/** Recovery is independent of GitHub work; normal receipts submit per-session workflows. */
export const SlackRecoveryCronName = "slack-startup-recovery"
export const SlackRecoveryCronLayer = Singleton.make(
  SlackRecoveryCronName,
  Effect.gen(function* () {
    const processor = yield* SlackProcessor
    yield* processor.processDue.pipe(
      Effect.catchCause((cause) => Effect.logError("Slack startup recovery failed", cause)),
    )
  }),
)
