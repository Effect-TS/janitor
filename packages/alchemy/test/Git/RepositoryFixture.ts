import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { makeSandboxLocal } from "../../src/AI/SandboxLocal.ts"
import * as Workspace from "../../src/Workspace/Workspace.ts"

export const repositoryFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const parent = yield* fs.makeTempDirectoryScoped()
  const source = path.join(parent, "source")
  const sandbox = yield* makeSandboxLocal.pipe(Effect.provide(Workspace.fixed(source)))
  const git = Effect.fnUntraced(function* (args: ReadonlyArray<string>) {
    const result = yield* sandbox.exec("git", args)
    if (!result.success) return yield* Effect.fail(result.stderr)
    return result.stdout.trim()
  })
  yield* git(["init", "-b", "main"])
  yield* git(["config", "user.name", "Sandbox Test"])
  yield* git(["config", "user.email", "sandbox@example.test"])
  yield* sandbox.writeFile("README.md", "initial")
  yield* git(["add", "."])
  yield* git(["commit", "-m", "initial"])
  const first = yield* git(["rev-parse", "HEAD"])
  yield* git(["checkout", "-b", "feature"])
  yield* sandbox.writeFile("README.md", "feature")
  yield* git(["commit", "-am", "feature"])
  yield* git(["update-ref", "refs/pull/7/head", "HEAD"])
  yield* git(["checkout", "main"])
  return { fs, path, parent, source, first, remote: { url: source }, sandbox }
})
