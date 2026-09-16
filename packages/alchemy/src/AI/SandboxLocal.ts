import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { Workspace } from "../Workspace/Workspace.ts"
import { Sandbox, type SandboxEntry, type SandboxExecOptions } from "./Sandbox.ts"

const shellQuote = (arg: string): string =>
  /^[A-Za-z0-9_/:=.,@%^+-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`

/** Shell and file operations on the current machine, also used inside the guest. */
export const makeSandboxLocal: Effect.Effect<
  Sandbox["Service"],
  never,
  Workspace | FileSystem.FileSystem | Path.Path | ChildProcessSpawner
> = Effect.gen(function* () {
  const workspace = yield* Workspace
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const environment = yield* Effect.context<ChildProcessSpawner>()

  const exec = Effect.fnUntraced(
    function* (command: string, args?: ReadonlyArray<string>, options?: SandboxExecOptions) {
      const root = yield* workspace.root
      const cwd =
        options?.cwd === undefined || options.cwd === "."
          ? root
          : yield* workspace.resolveExisting(options.cwd)
      const full = args?.length ? `${command} ${args.map(shellQuote).join(" ")}` : command
      const timeout = options?.timeout ?? 60_000
      const maxBytes = options?.maxRetainedBytes ?? 1_048_576
      const startedAt = yield* Clock.currentTimeMillis

      const handle = yield* ChildProcess.make(full, [], {
        cwd,
        shell: true,
        detached: true,
        ...(options?.env ? { env: options.env, extendEnv: true } : {}),
      }).pipe(
        Effect.mapError((error) => `[sandbox failure] the command never ran: ${String(error)}`),
      )

      const terminate = handle
        .kill({ killSignal: "SIGTERM", forceKillAfter: "1 second" })
        .pipe(Effect.ignore)

      const consume = <E>(stream: Stream.Stream<Uint8Array, E>) =>
        Stream.decodeText(stream).pipe(
          Stream.runFold(
            () => ({ text: "", truncated: false }),
            (output, chunk) => {
              const text = output.text + chunk
              const bytes = new TextEncoder().encode(text)
              return bytes.byteLength > maxBytes
                ? {
                    text: new TextDecoder().decode(bytes.slice(bytes.byteLength - maxBytes)),
                    truncated: true,
                  }
                : { text, truncated: output.truncated }
            },
          ),
          Effect.mapError(String),
        )

      const running = Effect.gen(function* () {
        const [exitCode, stdout, stderr] = yield* Effect.all(
          [handle.exitCode, consume(handle.stdout), consume(handle.stderr)],
          { concurrency: 3 },
        )
        return {
          success: exitCode === 0,
          exitCode,
          stdout: stdout.text,
          stderr: stderr.text,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          durationMs: (yield* Clock.currentTimeMillis) - startedAt,
        }
      }).pipe(
        Effect.mapError(String),
        Effect.onInterrupt(() => terminate),
      )

      return yield* Effect.raceFirst(
        running,
        Effect.sleep(`${timeout} millis`).pipe(
          Effect.andThen(Effect.forkChild(terminate)),
          Effect.andThen(
            Effect.fail(
              `command timed out after ${timeout}ms; retry with a larger timeout if it needs longer`,
            ),
          ),
        ),
      )
    },
    Effect.scoped,
    Effect.provide(environment),
  )

  const readFile = Effect.fnUntraced(function* (target: string) {
    const full = yield* workspace.resolveExisting(target)
    const info = yield* fs.stat(full).pipe(Effect.mapError(String))

    if (info.type !== "File") {
      return yield* Effect.fail(`not a regular file: ${target}`)
    }

    const bytes = yield* fs.readFile(full).pipe(Effect.mapError(String))

    if (bytes.includes(0)) {
      return yield* Effect.fail(`cannot read binary file: ${target} (NUL byte detected)`)
    }

    return yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      catch: () => `cannot decode ${target} as UTF-8 text`,
    })
  })

  const writeFile = Effect.fnUntraced(function* (target: string, content: string) {
    const full = yield* workspace.resolveForCreate(target)
    const directory = path.dirname(full)

    yield* fs.makeDirectory(directory, { recursive: true }).pipe(Effect.mapError(String))

    // Keep the temporary file on the same filesystem for an atomic rename.
    const temporaryDirectory = yield* fs
      .makeTempDirectoryScoped({ directory, prefix: ".alchemy-sandbox-write-" })
      .pipe(Effect.mapError(String))

    const temp = path.join(temporaryDirectory, "content")

    yield* fs
      .writeFileString(temp, content)
      .pipe(Effect.andThen(fs.rename(temp, full)), Effect.mapError(String))
  }, Effect.scoped)

  const deleteFile = Effect.fnUntraced(function* (target: string) {
    const full = yield* workspace.resolveExisting(target)
    yield* fs.remove(full).pipe(Effect.mapError(String))
  })

  const mkdir = Effect.fnUntraced(function* (target: string) {
    const full = yield* workspace.resolveForCreate(target)
    yield* fs.makeDirectory(full, { recursive: true }).pipe(Effect.mapError(String))
  })

  const listFiles = Effect.fnUntraced(function* (target?: string) {
    const relative = target ?? "."
    const full =
      relative === "." ? yield* workspace.root : yield* workspace.resolveExisting(relative)

    const info = yield* fs.stat(full).pipe(Effect.mapError(String))

    if (info.type !== "Directory") {
      return yield* Effect.fail(`not a directory: ${relative}`)
    }

    const names = yield* fs.readDirectory(full).pipe(Effect.mapError(String))
    const entries: SandboxEntry[] = []

    for (const name of names) {
      const child = yield* fs.stat(path.join(full, name)).pipe(Effect.mapError(String))
      entries.push({
        name,
        type: child.type === "Directory" ? "directory" : child.type === "File" ? "file" : "other",
      })
    }

    return entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
  })

  const exists = Effect.fnUntraced(function* (target: string) {
    const full = yield* workspace.resolve(target)
    return yield* fs.exists(full).pipe(Effect.mapError(String))
  })

  return Sandbox.of({
    exec,
    readFile,
    writeFile,
    deleteFile,
    mkdir,
    listFiles,
    exists,
  })
})

/** Runs as the host user; workspace path checks are not process isolation. */
export const layerLocal = Layer.effect(Sandbox, makeSandboxLocal)
