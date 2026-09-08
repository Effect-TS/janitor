import { assert, it } from "@effect/vitest"
import { proxyChain } from "alchemy/Util/proxy-chain"
import * as Effect from "effect/Effect"

it.effect("Alchemy queries yield concrete rows after an asynchronous boundary", () =>
  Effect.gen(function* () {
    const rows = [{ repository_id: "701" }]
    const query = proxyChain(Effect.succeed(() => Effect.succeed(rows)))
    yield* Effect.yieldNow
    assert.deepEqual(yield* query(), rows)
    assert.deepEqual(yield* Effect.mapEager(query(), (result) => result[0].repository_id), "701")
    assert.deepEqual(yield* query().pipe(Effect.map((result) => result[0].repository_id)), "701")
  }),
)
