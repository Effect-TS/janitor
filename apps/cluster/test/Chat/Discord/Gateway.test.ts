import { assert, describe, it } from "@effect/vitest"
import { GatewayIntentBits } from "dfx/types"
import { forgetShardStateOnIntentsChange } from "../../../src/Chat/Discord/Gateway.ts"

const withoutReactions = GatewayIntentBits.GuildMessages
const withReactions = GatewayIntentBits.GuildMessages | GatewayIntentBits.GuildMessageReactions

describe("Discord gateway shard state", () => {
  it("is kept while the intents are unchanged", () => {
    const kv = new Map([["shard-state", "session"]])
    forgetShardStateOnIntentsChange(kv, withReactions)
    kv.set("shard-state", "session")

    forgetShardStateOnIntentsChange(kv, withReactions)
    assert.strictEqual(kv.get("shard-state"), "session")
  })

  it("is forgotten when it was stored before the intents were recorded", () => {
    const kv = new Map([["shard-state", "session"]])

    forgetShardStateOnIntentsChange(kv, withReactions)
    assert.isFalse(kv.has("shard-state"))
  })

  it("is forgotten when the intents change", () => {
    const kv = new Map<string, string>()
    forgetShardStateOnIntentsChange(kv, withoutReactions)
    kv.set("shard-state", "session")

    forgetShardStateOnIntentsChange(kv, withReactions)
    assert.isFalse(kv.has("shard-state"))
  })
})
