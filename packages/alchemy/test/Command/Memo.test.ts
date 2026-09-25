import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, it } from "@effect/vitest"
import { hashDirectory } from "alchemy/Command/Memo"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"

it.live("still hashes selected deployment files after lazily loading the glob library", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const cwd = yield* fs.makeTempDirectoryScoped()
    const included = path.join(cwd, "input.txt")
    const excluded = path.join(cwd, "ignored.txt")
    yield* fs.writeFileString(included, "first")
    yield* fs.writeFileString(excluded, "first")
    const hash = hashDirectory({ cwd, memo: { include: ["*.txt"], exclude: ["ignored.txt"] } })
    const initial = yield* hash
    assert.equal(yield* hash, initial)
    yield* fs.writeFileString(excluded, "second")
    assert.equal(yield* hash, initial)
    yield* fs.writeFileString(included, "second")
    assert.notEqual(yield* hash, initial)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)
