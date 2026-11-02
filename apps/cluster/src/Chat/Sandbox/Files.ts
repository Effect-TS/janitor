import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"

/**
 * Reading a file the chat agent attaches to its reply (EFF-3309). The bot
 * posts to public channels, so this is the boundary that keeps the rest of
 * the container, credentials and the egress config included, out of them.
 */

/** A file the agent asked for that it can't attach. `reason` is for the model. */
export class WorkspaceFileRejected extends Data.TaggedError("WorkspaceFileRejected")<{
  readonly reason: string
}> {}

/** Whether `target` is under `directory`; both are absolute and normalized. */
const within = (path: Path.Path, directory: string, target: string) => {
  const relative = path.relative(directory, target)
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

/**
 * Reads the file at `path`, an absolute path under `workspace`. Symlinks are
 * resolved first, and anything that resolves outside `workspace`, that isn't
 * a regular file, or that is larger than `maxBytes` is rejected.
 */
export const readWorkspaceFile = (options: {
  readonly workspace: string
  readonly path: string
  readonly maxBytes: number
}): Effect.Effect<Uint8Array, WorkspaceFileRejected, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const outside = new WorkspaceFileRejected({
      reason: `${options.path} is not a file under ${options.workspace}`,
    })
    if (!path.isAbsolute(options.path)) return yield* outside
    if (!within(path, options.workspace, path.normalize(options.path))) return yield* outside
    const missing = () => new WorkspaceFileRejected({ reason: `${options.path} doesn't exist` })
    const workspace = yield* fs.realPath(options.workspace).pipe(Effect.mapError(missing))
    // The file itself, every symlink on its way resolved: what is read.
    const real = yield* fs.realPath(options.path).pipe(Effect.mapError(missing))
    if (!within(path, workspace, real)) return yield* outside
    const info = yield* fs.stat(real).pipe(Effect.mapError(missing))
    if (info.type !== "File") return yield* outside
    if (Number(info.size) > options.maxBytes)
      return yield* new WorkspaceFileRejected({
        reason: `${options.path} is larger than ${options.maxBytes} bytes`,
      })
    const content = yield* fs.readFile(real).pipe(Effect.mapError(missing))
    // The file can grow between the stat and the read.
    if (content.length > options.maxBytes)
      return yield* new WorkspaceFileRejected({
        reason: `${options.path} is larger than ${options.maxBytes} bytes`,
      })
    return content
  })
