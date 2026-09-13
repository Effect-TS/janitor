import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Singleton from "effect/unstable/cluster/Singleton"
import { SlackProcessor } from "./Processor.ts"
import { SlackDelivery } from "./Delivery.ts"
import { GitHubFeedback } from "../GitHub/Feedback.ts"
import { GitHubDelivery } from "../GitHub/FeedbackDelivery.ts"

export const SlackCronName = "slack-conversations"
export const SlackCronLayer = Singleton.make(
  SlackCronName,
  Effect.gen(function* () {
    const processor = yield* SlackProcessor
    const delivery = yield* SlackDelivery
    const feedback = yield* GitHubFeedback
    const github = yield* GitHubDelivery
    const started = yield* Clock.currentTimeMillis
    // Durable rows survive missed wakes; the minute cron always restarts discovery.
    while ((yield* Clock.currentTimeMillis) - started < 50_000) {
      yield* feedback.processDue.pipe(
        Effect.catchCause((cause) => Effect.logError("GitHub feedback hydration failed", cause)),
      )
      yield* processor.processDue.pipe(
        Effect.catchCause((cause) => Effect.logError("Slack initialization failed", cause)),
      )
      yield* delivery.processDue.pipe(
        Effect.catchCause((cause) => Effect.logError("Slack publication failed", cause)),
      )
      yield* github.processDue.pipe(
        Effect.catchCause((cause) => Effect.logError("GitHub feedback publication failed", cause)),
      )
      yield* Effect.sleep(1000)
    }
  }),
)
