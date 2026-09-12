import { Duration, Effect, Sink, Stream } from "effect"
import * as Spawner from "effect/unstable/process/ChildProcessSpawner"
import { Buffer } from "node:buffer"
const randomUUID = () => crypto.randomUUID()
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Narrow fixture adapter; unsupported process options remain explicit.
const attempt = (run) => Effect.tryPromise({ try: run, catch: (error) => error })
export const makeFixtureSpawner = (rpc) =>
  Spawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand" || command.options.additionalFds) {
        return yield* Effect.fail(new Error("unsupported in narrow fixture adapter"))
      }
      const id = randomUUID()
      const started = yield* attempt(() =>
        rpc("/process", {
          id,
          argv: [command.command, ...command.args],
          env: command.options.env ?? {},
          cwd: command.options.cwd,
        }),
      )
      let inputSeq = 0
      const write = (bytes, end = false) =>
        attempt(() =>
          rpc(`/process/${id}/stdin`, {
            seq: inputSeq++,
            base64: Buffer.from(bytes).toString("base64"),
            end,
          }),
        )
      const kill = (options = {}) =>
        attempt(async () => {
          const signal = options.killSignal ?? "SIGTERM"
          if (!["SIGTERM", "SIGKILL"].includes(signal))
            throw new Error("unsupported signal in fixture")
          await rpc(`/process/${id}/kill`, { signal })
          const deadline =
            options.forceKillAfter === undefined
              ? Infinity
              : Date.now() + Duration.toMillis(options.forceKillAfter)
          let forced = signal === "SIGKILL"
          while (!(await rpc(`/process/${id}`)).closed) {
            if (!forced && Date.now() >= deadline) {
              await rpc(`/process/${id}/kill`, { signal: "SIGKILL" })
              forced = true
            }
            await delay(10)
          }
        })
      yield* Effect.addFinalizer(() => Effect.ignore(kill({ killSignal: "SIGKILL" })))
      const stdin = Sink.forEach((bytes) => write(bytes)).pipe(
        Sink.ensuring(Effect.ignore(write(new Uint8Array(), true))),
      )
      if (Stream.isStream(command.options.stdin)) {
        yield* Stream.run(command.options.stdin, stdin).pipe(Effect.forkScoped)
      } else {
        yield* write(new Uint8Array(), true)
      }
      const output = (kind) =>
        Stream.fromAsyncIterable(
          (async function* () {
            let after = 0
            for (;;) {
              const result = await rpc(`/process/${id}?after=${after}`)
              if (result.error || result.overflow)
                throw new Error(result.error ?? "output overflow")
              for (const frame of result.frames) {
                after = frame.seq
                if (kind === "all" || frame.kind === kind)
                  yield new Uint8Array(Buffer.from(frame.base64, "base64"))
              }
              if (result.closed) return
              await delay(10)
            }
          })(),
          (error) => error,
        )
      return Spawner.makeHandle({
        pid: Spawner.ProcessId(started.pid),
        stdin,
        stdout: output("stdout"),
        stderr: output("stderr"),
        all: output("all"),
        exitCode: attempt(async () => {
          for (;;) {
            const result = await rpc(`/process/${id}`)
            if (result.error || result.overflow) throw new Error(result.error ?? "output overflow")
            if (result.closed) {
              if (result.signal) throw new Error(`terminated by ${result.signal}`)
              return Spawner.ExitCode(result.code)
            }
            await delay(10)
          }
        }),
        isRunning: attempt(async () => !(await rpc(`/process/${id}`)).closed),
        kill,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      })
    }),
  )
