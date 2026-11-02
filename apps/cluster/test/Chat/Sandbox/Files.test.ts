import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { readWorkspaceFile } from "../../../src/Chat/Sandbox/Files.ts"

/**
 * The chat sandbox's read of a file the agent attaches (EFF-3309), over a
 * real filesystem. It is the boundary that keeps the rest of the container,
 * credentials included, out of public channels.
 */

describe("chat sandbox file reads", () => {
  it.effect("reads a file under the workspace, and nothing that resolves outside it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "janitor-chat-files-" })
      const workspace = path.join(root, "workspace")
      const secret = path.join(root, "secret.txt")
      yield* fs.makeDirectory(path.join(workspace, "out"), { recursive: true })
      yield* fs.writeFile(path.join(workspace, "out", "plot.png"), new Uint8Array([137, 80, 78]))
      yield* fs.writeFileString(path.join(workspace, "big.log"), "x".repeat(101))
      yield* fs.writeFileString(secret, "token")
      yield* fs.symlink(secret, path.join(workspace, "notes.txt"))
      yield* fs.symlink(root, path.join(workspace, "up"))

      const read = (target: string, maxBytes = 100) =>
        readWorkspaceFile({ workspace, path: target, maxBytes }).pipe(Effect.exit)

      const inside = yield* read(path.join(workspace, "out", "plot.png"))
      assert.deepStrictEqual(inside, Exit.succeed(new Uint8Array([137, 80, 78])))

      for (const target of [
        `${workspace}/out/../../secret.txt`,
        secret,
        // Symlinks inside the workspace, to a file and to a directory outside it.
        path.join(workspace, "notes.txt"),
        path.join(workspace, "up", "secret.txt"),
        // Under the workspace, but over the size limit.
        path.join(workspace, "big.log"),
      ]) {
        assert.isTrue(Exit.isFailure(yield* read(target)), target)
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})
