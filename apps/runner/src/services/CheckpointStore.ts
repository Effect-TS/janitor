import { timed } from "./Telemetry.ts"
import { Context, Effect, Layer } from "effect"
import { ProtocolError } from "../Protocol.ts"
import type { Archive } from "../WorkspaceCheckpoints.ts"

/** Streams immutable archives. The session journal, not R2, owns the committed pointer. */
export class CheckpointStore extends Context.Service<
  CheckpointStore,
  {
    readonly available: boolean
    readonly upload: (key: string, archive: Archive) => Effect.Effect<void, ProtocolError>
    readonly read: (key: string, sha256: string) => Effect.Effect<Archive, ProtocolError>
    readonly remove: (key: string) => Effect.Effect<void, ProtocolError>
  }
>()("janitor/runner/CheckpointStore") {
  static make(bucket: R2Bucket | undefined): CheckpointStore["Service"] {
    const required = bucket
      ? Effect.succeed(bucket)
      : Effect.fail(new ProtocolError("blocked", "Workspace checkpoint bucket is not configured"))
    const failure = () => new ProtocolError("transport", "Workspace archive storage is unavailable")
    return {
      available: bucket !== undefined,
      upload: Effect.fn("CheckpointStore.upload")(function* (key, archive) {
        const bucket = yield* required
        // R2 requires a known length. Keep backpressure and abort the source if the
        // write fails; never leave a pump running after the operation has returned.
        yield* Effect.tryPromise({
          try: async (signal) => {
            const transfer = new FixedLengthStream(archive.size)
            const controller = new AbortController()
            const abort = () => controller.abort()
            signal.addEventListener("abort", abort, { once: true })
            const pump = archive.body.pipeTo(transfer.writable, { signal: controller.signal })
            try {
              await Promise.all([
                pump,
                bucket.put(key, transfer.readable, { sha256: archive.sha256 }),
              ])
            } finally {
              controller.abort()
              signal.removeEventListener("abort", abort)
              await pump.catch(() => {})
            }
          },
          catch: failure,
        }).pipe(timed("checkpoint.upload", { bytes: archive.size }))
      }),
      read: Effect.fn("CheckpointStore.read")(function* (key, sha256) {
        const bucket = yield* required
        const object = yield* Effect.tryPromise({ try: () => bucket.get(key), catch: failure })
        if (!object)
          return yield* Effect.fail(
            new ProtocolError("blocked", "Committed workspace archive is unavailable"),
          )
        return { body: object.body, size: object.size, sha256 }
      }),
      remove: Effect.fn("CheckpointStore.remove")(function* (key) {
        const bucket = yield* required
        yield* Effect.tryPromise({ try: () => bucket.delete(key), catch: failure })
      }),
    }
  }
  static layer(bucket: R2Bucket | undefined) {
    return Layer.succeed(this, this.make(bucket))
  }
}
