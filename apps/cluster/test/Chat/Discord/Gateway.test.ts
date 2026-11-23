import { describe, it, assert } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { GatewayIntentBits } from "dfx/types"
import { makeShardStateStore } from "../../../src/Chat/Discord/Gateway.ts"

const makeKv = (initial?: Record<string, string>) => {
  const map = new Map(Object.entries(initial ?? {}))
  return {
    get: (key: string) => map.get(key),
    set: (key: string, value: string) => {
      map.set(key, value)
    },
    delete: (key: string) => {
      map.delete(key)
    },
  }
}

const sampleState = {
  sessionId: "session-1",
  resumeUrl: "wss://gateway.discord.gg",
  sequence: 42,
}

describe("Discord gateway shard state store", () => {
  it.effect("persists and resumes shard state when intents match", () =>
    Effect.gen(function* () {
      const kv = makeKv()
      const shard = makeShardStateStore(
        kv,
        GatewayIntentBits.GuildMessages | GatewayIntentBits.GuildMessageReactions,
      ).store.forShard([0, 1])

      assert.isTrue(Option.isNone(yield* shard.get))
      yield* shard.set(sampleState)
      assert.deepStrictEqual(yield* shard.get, Option.some(sampleState))
      yield* shard.clear
      assert.isTrue(Option.isNone(yield* shard.get))
    }),
  )

  it.effect("discards stored shard state when intents are unrecorded or changed", () =>
    Effect.gen(function* () {
      const legacyKv = makeKv({ "shard-state": JSON.stringify(sampleState) })
      const legacyShard = makeShardStateStore(
        legacyKv,
        GatewayIntentBits.GuildMessages | GatewayIntentBits.GuildMessageReactions,
      ).store.forShard([0, 1])

      assert.isTrue(Option.isNone(yield* legacyShard.get))
      assert.isUndefined(legacyKv.get("shard-state"))

      const oldIntents = GatewayIntentBits.GuildMessages
      const newIntents = GatewayIntentBits.GuildMessages | GatewayIntentBits.GuildMessageReactions
      const kv = makeKv()
      yield* makeShardStateStore(kv, oldIntents).store.forShard([0, 1]).set(sampleState)

      const updatedShard = makeShardStateStore(kv, newIntents).store.forShard([0, 1])
      assert.isTrue(Option.isNone(yield* updatedShard.get))
      assert.isUndefined(kv.get("shard-state"))
    }),
  )
})
