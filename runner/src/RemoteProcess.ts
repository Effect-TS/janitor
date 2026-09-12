import { Duration, Effect, PlatformError, Sink, Stream } from "effect"
import * as Spawner from "effect/unstable/process/ChildProcessSpawner"
import { Buffer } from "node:buffer"

export interface ProcessStatus {
  readonly closed: boolean
  readonly code: number | null
  readonly signal: string | null
  readonly error: string | null
  readonly frames: ReadonlyArray<{ seq: number; kind: string; base64: string }>
}
export type BridgeRpc = <A>(path: string, input?: unknown) => Promise<A>
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const failure = (cause: unknown) =>
  new PlatformError.PlatformError(
    new PlatformError.SystemError({
      _tag: "Unknown",
      module: "ChildProcess",
      method: "bridge",
      description: String(cause),
    }),
  )
const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: failure })

/** Native files and search use this same process interface. No session shell is exposed. */
export const makeRemoteSpawner = (rpc: BridgeRpc) =>
  Spawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand" || command.options.additionalFds)
        return yield* Effect.fail(
          failure("Pipeline objects and extra file descriptors are unsupported"),
        )
      const id = crypto.randomUUID()
      const started = yield* attempt(() =>
        rpc<{ pid: number }>("/process", {
          id,
          argv: [command.command, ...command.args],
          env: command.options.env ?? {},
          cwd: command.options.cwd,
        }),
      )
      let inputSeq = 0
      const write = (bytes: Uint8Array, end = false) =>
        Effect.suspend(() => {
          const input = { seq: inputSeq++, base64: Buffer.from(bytes).toString("base64"), end }
          return attempt(() => rpc(`/process/${id}/stdin`, input))
        })
      const status = () => rpc<ProcessStatus>(`/process/${id}`)
      const kill: Spawner.ChildProcessHandle["kill"] = (options = {}) =>
        attempt(async () => {
          const signal = options.killSignal ?? "SIGTERM"
          if (signal !== "SIGTERM" && signal !== "SIGKILL") throw new Error("Unsupported signal")
          await rpc(`/process/${id}/kill`, { signal })
          const deadline =
            Date.now() +
            (options.forceKillAfter === undefined
              ? 1000
              : Duration.toMillis(options.forceKillAfter))
          let forced = signal === "SIGKILL"
          while (!(await status()).closed) {
            if (!forced && Date.now() >= deadline) {
              await rpc(`/process/${id}/kill`, { signal: "SIGKILL" })
              forced = true
            }
            await delay(20)
          }
        })
      yield* Effect.addFinalizer(() => Effect.ignore(kill({ killSignal: "SIGKILL" })))
      const stdin = Sink.forEach((bytes: Uint8Array) => write(bytes)).pipe(
        Sink.ensuring(Effect.ignore(write(new Uint8Array(), true))),
      )
      if (Stream.isStream(command.options.stdin)) {
        yield* Stream.run(command.options.stdin, stdin).pipe(Effect.forkScoped)
      } else if (command.options.stdin !== "pipe") {
        yield* write(new Uint8Array(), true)
      }
      const output = (kind: string) =>
        Stream.fromAsyncIterable(
          (async function* () {
            let after = 0
            for (;;) {
              const result = await rpc<ProcessStatus>(`/process/${id}?after=${after}`)
              if (result.error) throw new Error(result.error)
              for (const frame of result.frames) {
                after = frame.seq
                if (kind === "all" || frame.kind === kind)
                  yield new Uint8Array(Buffer.from(frame.base64, "base64"))
              }
              // A closed operation can have more than one page of buffered output.
              if (result.closed && result.frames.length < 256) return
              await delay(20)
            }
          })(),
          failure,
        )
      return Spawner.makeHandle({
        pid: Spawner.ProcessId(started.pid),
        stdin,
        stdout: output("stdout"),
        stderr: output("stderr"),
        all: output("all"),
        exitCode: attempt(async () => {
          for (;;) {
            const result = await status()
            if (result.error) throw new Error(result.error)
            if (result.closed) {
              if (result.signal || result.code === null)
                throw new Error(`Process terminated: ${result.signal}`)
              return Spawner.ExitCode(result.code)
            }
            await delay(20)
          }
        }),
        isRunning: attempt(async () => !(await status()).closed),
        kill,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.fail(failure("Background processes are unavailable")),
      })
    }),
  )
