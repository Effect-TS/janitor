// Tells the API that a session has new readable events. The API polls the
// runner on a cadence and keeps doing so; this only shortens the wait between
// an event landing and a teammate seeing it. Calls are debounced per object
// and never block turn work; a lost call is recovered by the next poll.
import { Redacted } from "effect"

const DEBOUNCE_MS = 1_000

export interface NotifierBinding {
  readonly fetch: (request: Request) => Promise<Response>
}

export interface NotifierDependencies {
  readonly session: () => { readonly sessionId: string; readonly generation: number } | undefined
  /** Keeps the request alive after the current handler returns. */
  readonly background: (work: Promise<void>) => void
  readonly journal: (kind: string, data?: unknown) => void
  readonly debounceMs?: number
}

export class EventNotifier {
  static make(
    binding: NotifierBinding | undefined,
    token: string | undefined,
    deps: NotifierDependencies,
  ): EventNotifier {
    return new EventNotifier(binding, Redacted.make(token ?? ""), deps)
  }

  private timer: ReturnType<typeof setTimeout> | undefined

  private constructor(
    private readonly binding: NotifierBinding | undefined,
    private readonly token: Redacted.Redacted<string>,
    private readonly deps: NotifierDependencies,
  ) {}

  /** Schedules one notification for the coming debounce window. */
  notify(): void {
    if (this.timer !== undefined) return
    if (!this.binding || Redacted.value(this.token) === "") return
    this.timer = setTimeout(() => {
      this.timer = undefined
      const session = this.deps.session()
      if (session === undefined) return
      this.deps.background(this.send(session))
    }, this.deps.debounceMs ?? DEBOUNCE_MS)
  }

  private async send(session: { sessionId: string; generation: number }): Promise<void> {
    try {
      const response = await this.binding!.fetch(
        new Request("https://janitor/api/v1/agent/events", {
          method: "POST",
          headers: {
            authorization: `Bearer ${Redacted.value(this.token)}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(session),
          signal: AbortSignal.timeout(5_000),
        }),
      )
      if (!response.ok) this.deps.journal("notify-refused", { status: response.status })
    } catch (cause) {
      this.deps.journal("notify-failed", { error: String(cause) })
    }
  }
}
