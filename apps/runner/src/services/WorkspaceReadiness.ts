// The gate between the model and the checkout. A turn starts the model and
// the workspace preparation together so the first sentence reaches the thread
// while a clone or restore is still running; every sandbox tool waits here
// until preparation has finished, and fails if it never does.
import { Effect } from "effect"
import { WorkspaceError } from "./SandboxWorkspace.ts"

type Gate = {
  readonly promise: Promise<void>
  readonly open: () => void
  readonly fail: (message: string) => void
}

const closedGate = (): Gate => {
  let open!: () => void
  let fail!: (message: string) => void
  const promise = new Promise<void>((resolve, reject) => {
    open = resolve
    fail = (message) => reject(new WorkspaceError({ reason: "unavailable", message }))
  })
  // A gate that fails before anyone waits must not surface as an unhandled rejection.
  promise.catch(() => undefined)
  return { promise, open, fail }
}

export class WorkspaceReadiness {
  private gate: Gate = closedGate()
  private state: "closed" | "open" | "failed" = "closed"

  get isOpen(): boolean {
    return this.state === "open"
  }

  /** Closes the gate for a new turn. */
  reset(): void {
    this.gate = closedGate()
    this.state = "closed"
  }

  /** The workspace is prepared; waiting tools proceed. */
  open(): void {
    if (this.state !== "closed") return
    this.state = "open"
    this.gate.open()
  }

  /** Preparation ended without a workspace; waiting tools fail with the reason. */
  fail(message: string): void {
    if (this.state !== "closed") return
    this.state = "failed"
    this.gate.fail(message)
  }

  /** Resolves once the workspace is prepared for the current turn. */
  get ready(): Effect.Effect<void, WorkspaceError> {
    return Effect.suspend(() =>
      Effect.tryPromise({
        try: () => this.gate.promise,
        catch: (cause) =>
          cause instanceof WorkspaceError
            ? cause
            : new WorkspaceError({ reason: "unavailable", message: String(cause) }),
      }),
    )
  }
}
