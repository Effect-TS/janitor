import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"

/** Workspace paths are relative to a canonical root, including through symlinks. */
export class Workspace extends Context.Service<
  Workspace,
  {
    readonly root: Effect.Effect<string, string>
    readonly resolve: (relative: string) => Effect.Effect<string, string>
    readonly resolveExisting: (relative: string) => Effect.Effect<string, string>
    readonly resolveForCreate: (relative: string) => Effect.Effect<string, string>
  }
>()("@janitor/alchemy/Workspace") {}

/** Create the directory on first use, so planning never touches the guest's disk. */
export const fixed = (
  root: string,
): Layer.Layer<Workspace, never, Path.Path | FileSystem.FileSystem> =>
  Layer.effect(
    Workspace,
    Effect.gen(function* () {
      const path = yield* Path.Path
      const fs = yield* FileSystem.FileSystem
      const canonicalRoot = yield* Effect.cached(
        Effect.gen(function* () {
          const resolved = path.resolve(root)
          yield* fs.makeDirectory(resolved, { recursive: true })
          return yield* fs.realPath(resolved)
        }).pipe(Effect.mapError(String)),
      )

      const contain = Effect.fnUntraced(function* (candidate: string) {
        const fromRoot = path.relative(yield* canonicalRoot, candidate)
        if (
          fromRoot === "" ||
          (fromRoot !== ".." && !fromRoot.startsWith(`..${path.sep}`) && !path.isAbsolute(fromRoot))
        ) {
          return candidate
        }
        return yield* Effect.fail(`[policy denial] path escapes the workspace: ${candidate}`)
      })

      const resolve = Effect.fnUntraced(function* (relative: string) {
        if (relative.length === 0 || path.isAbsolute(relative)) {
          return yield* Effect.fail(`[policy denial] path must be workspace-relative: ${relative}`)
        }
        return yield* contain(path.resolve(yield* canonicalRoot, relative))
      })

      const resolveExisting = Effect.fnUntraced(function* (relative: string) {
        const candidate = yield* resolve(relative)
        const canonical = yield* fs.realPath(candidate).pipe(Effect.mapError(String))
        return yield* contain(canonical)
      })

      const resolveForCreate = Effect.fnUntraced(function* (relative: string) {
        const candidate = yield* resolve(relative)
        const missing: string[] = []

        let parent = candidate
        while (!(yield* fs.exists(parent).pipe(Effect.mapError(String)))) {
          const next = path.dirname(parent)
          if (next === parent) {
            return yield* Effect.fail(`could not resolve a parent for ${relative}`)
          }
          missing.unshift(path.basename(parent))
          parent = next
        }

        const canonical = yield* fs.realPath(parent).pipe(Effect.mapError(String))

        yield* contain(canonical)

        return path.join(canonical, ...missing)
      })

      return Workspace.of({
        root: canonicalRoot,
        resolve: resolveForCreate,
        resolveExisting,
        resolveForCreate,
      })
    }),
  )
