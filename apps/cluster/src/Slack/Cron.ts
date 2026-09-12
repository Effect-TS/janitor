import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Singleton from "effect/unstable/cluster/Singleton"
import { SlackProcessor } from "./Processor.ts"
import { SlackDelivery } from "./Delivery.ts"

export const SlackCronName = "slack-conversations"
export const SlackCronLayer = Singleton.make(
  SlackCronName,
  Effect.gen(function* () {
    const processor = yield* SlackProcessor
    const delivery = yield* SlackDelivery
    const started = yield* Clock.currentTimeMillis
    // Durable rows survive missed wakes; the minute cron always restarts discovery.
    while ((yield* Clock.currentTimeMillis) - started < 50_000) {
      yield* processor.processDue.pipe(
        Effect.catchCause((cause) => Effect.logError("Slack initialization failed", cause)),
      )
      yield* delivery.processDue.pipe(
        Effect.catchCause((cause) => Effect.logError("Slack publication failed", cause)),
      )
      yield* Effect.sleep(1000)
    }
  }),
)
