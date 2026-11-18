/**
 * The probe's lifecycle decisions, apart from workerd so they can be tested:
 * what each alarm does, and how a container is ended.
 */

/** What the operator asked for; kept in storage so alarms honour it. */
export interface Desired {
  readonly running: boolean
  /** The fixed time limit, set by `/start` and never extended while running. */
  readonly until: number
  readonly transitionZeroFix: boolean
}

/** The part of workerd's `ctx.container` that ending one needs. */
export interface EndableContainer {
  readonly running: boolean
  signal(signo: number): void
  destroy(): Promise<void>
}

/**
 * - poll: running as asked; collect its events
 * - restart: should run but doesn't
 * - teardown: should not run (stopped or past its time limit) but does; try again
 * - done: off as asked; no more alarms
 */
export type AlarmAction = "poll" | "restart" | "teardown" | "done"

export const alarmAction = (desired: Desired, running: boolean, now: number): AlarmAction => {
  const wanted = desired.running && now < desired.until
  if (wanted) return running ? "poll" : "restart"
  return running ? "teardown" : "done"
}

/** Resolves with the promise's value, or undefined once `ms` pass. Never rejects. */
export const within = <A>(promise: Promise<A>, ms: number): Promise<A | undefined> => {
  let timer: Parameters<typeof clearTimeout>[0]
  return Promise.race([
    promise.catch(() => undefined),
    new Promise<undefined>((resolve) => {
      timer = setTimeout(resolve, ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/**
 * Signals the container, waits up to `exitMs` for `exited`, then destroys it,
 * waiting up to `destroyMs`. True only once the container is confirmed not
 * running; false means the caller must try again. Never throws.
 */
export const endContainer = async (
  container: EndableContainer,
  options: {
    readonly signal: 9 | 15
    readonly exited: Promise<unknown>
    readonly exitMs: number
    readonly destroyMs: number
  },
): Promise<boolean> => {
  if (!container.running) return true
  try {
    container.signal(options.signal)
  } catch {
    // Destroying below still ends it.
  }
  await within(options.exited, options.exitMs)
  if (container.running) {
    await within(
      Promise.resolve().then(() => container.destroy()),
      options.destroyMs,
    )
  }
  return !container.running
}
