import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import { serveWorkspace } from "./WorkspaceServe.ts"

Effect.gen(function* () {
  const root = yield* Config.String("WORKSPACE_ROOT").pipe(
    Config.withDefault("../../.alchemy/workspaces"),
  )
  const port = yield* Config.Int("PORT").pipe(Config.withDefault(4789))
  const url = yield* serveWorkspace({ root, port })
  yield* Console.log(url)
  return yield* Effect.never
}).pipe(Effect.scoped, NodeRuntime.runMain)
