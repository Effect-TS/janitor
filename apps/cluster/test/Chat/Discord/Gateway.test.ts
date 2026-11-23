import { assert, describe, it } from "@effect/vitest"
import { GatewayIntentBits } from "dfx/types"
import { forgetShardStateOnIntentsChange } from "../../../src/Chat/Discord/Gateway.ts"

const withoutReactions = GatewayIntentBits.GuildMessages
const withReactions = GatewayIntentBits.GuildMessages | GatewayIntentBits.GuildMessageReactions

describe("Discord gateway shard state", () => {
  it("resumes while intents match and re-identifies when unrecorded or changed", () => {
    const kv = new Map([["shard-state", "session"]])

    forgetShardStateOnIntentsChange(kv, withoutReactions)
    assert.isFalse(kv.has("shard-state"))

    kv.set("shard-state", "session")
    forgetShardStateOnIntentsChange(kv, withoutReactions)
    assert.strictEqual(kv.get("shard-state"), "session")

    forgetShardStateOnIntentsChange(kv, withReactions)
    assert.isFalse(kv.has("shard-state"))
  })
})
