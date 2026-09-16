import { makeFetchRpcStub } from "alchemy/Rpc"
import * as Effect from "effect/Effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import type { WorkspaceHostShape } from "./WorkspaceHost.ts"

/** Resolve the dev URL on each call so a restarted host can change address. */
export const makeWorkspaceClient = Effect.fnUntraced(function* (
  url: string | Effect.Effect<string | undefined>,
) {
  const client = yield* HttpClient.HttpClient
  // Deliberately return a deferred lookup; the URL binding can change between calls.
  // oxlint-disable-next-line effecttsgo/return-effect-in-gen
  return Effect.gen(function* () {
    const base = typeof url === "string" ? url : yield* url
    if (!base) {
      return yield* Effect.fail("workspace server URL is missing; start the Node workspace server")
    }
    return makeFetchRpcStub<WorkspaceHostShape>({
      baseUrl: base.replace(/\/+$/, ""),
      fetch: (request) => client.execute(request),
    })
  })
})
