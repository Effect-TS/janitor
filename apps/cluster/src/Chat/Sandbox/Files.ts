import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Stream from "effect/Stream"

/**
 * Reading a file the chat agent attaches to its reply (EFF-3309). The bot
 * posts to public channels, so an attachment is only ever a file under
 * `/workspace`: no path or symlink reaches the rest of the container.
 *
 * It is not a boundary against the agent's own scripts, which run as root
 * in the same container: they can copy any file into `/workspace`, so a
 * symlink swapped in during the read gains them nothing. What keeps
 * credentials out of a post is that the container holds none; the egress
 * proxy swaps in the real tokens.
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
    const tooLarge = new WorkspaceFileRejected({
      reason: `${options.path} is larger than ${options.maxBytes} bytes`,
    })
    if (Number(info.size) > options.maxBytes) return yield* tooLarge
    // The file can grow after the stat, so the read stops one byte past the limit.
    const chunks = yield* fs
      .stream(real, { bytesToRead: options.maxBytes + 1 })
      .pipe(Stream.runCollect, Effect.mapError(missing))
    const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    if (size > options.maxBytes) return yield* tooLarge
    const content = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      content.set(chunk, offset)
      offset += chunk.length
    }
    return content
  })
