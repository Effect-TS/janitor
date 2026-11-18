/**
 * The probe's lifecycle, apart from workerd so it can be tested: starting,
 * restarting and ending the container, and what each alarm does. The Durable
 * Object supplies storage, the container and polling through `Host`.
 *
 * Starts, restarts, stops and alarms run one at a time. A stop marks the
 * probe stopped before it queues, and a start checks that mark at the moment
 * it would start the container, so nothing already in flight can bring the
 * container back after `/stop`.
 */

/** What the operator asked for; kept in storage so alarms honour it. */
export interface Desired {
  readonly running: boolean
  /** The fixed time limit, set by `/start` and never extended while running. */
  readonly until: number
  readonly transitionZeroFix: boolean
  /** Salt for the container's user aliases: one per run, so aliases survive restarts. */
  readonly aliasSalt: string
}

/** The part of workerd's `ctx.container` that ending one needs. */
export interface EndableContainer {
  readonly running: boolean
  signal(signo: number): void
  destroy(): Promise<void>
}

export interface ProbeContainer extends EndableContainer {
  /** Starts the container for this run; may throw. */
  start(desired: Desired): void
  /** Settles when the started container exits. */
  monitor(): Promise<unknown>
  /** The container's boot id once it answers its health check, bounded; undefined if it doesn't. */
  health(): Promise<string | undefined>
}

export interface Host {
  readonly container: ProbeContainer
  now(): number
  sleep(ms: number): Promise<void>
  get<A>(key: string): Promise<A | undefined>
  put(key: string, value: unknown): Promise<void>
  setAlarm(at: number): Promise<void>
  deleteAlarm(): Promise<void>
  record(kind: string, detail?: Record<string, unknown>): void
  /** Collects the container's events; the latest snapshot, or undefined. Bounded; never throws. */
  poll(): Promise<{ readonly bootId?: unknown; readonly presentUserIds?: unknown } | undefined>
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
 * How ending went: "not running" (nothing to end), "exited" (it left after
 * the signal), "destroyed" (it ignored the signal and was destroyed), or
 * "running" (still on; try again).
 */
export type EndOutcome = "not running" | "exited" | "destroyed" | "running"

/**
 * Signals the container, waits up to `exitMs` for `exited`, then destroys it,
 * waiting up to `destroyMs`. Never throws.
 */
export const endContainer = async (
  container: EndableContainer,
  options: {
    readonly signal: 9 | 15
    readonly exited: Promise<unknown>
    readonly exitMs: number
    readonly destroyMs: number
  },
): Promise<EndOutcome> => {
  if (!container.running) return "not running"
  try {
    container.signal(options.signal)
  } catch {
    // Destroying below still ends it.
  }
  await within(options.exited, options.exitMs)
  if (!container.running) return "exited"
  await within(
    Promise.resolve().then(() => container.destroy()),
    options.destroyMs,
  )
  return container.running ? "running" : "destroyed"
}

const POLL_MS = 15_000
const DEFAULT_HOURS = 3
const MAX_HOURS = 6
const START_BUDGET_MS = 60_000
const EXIT_BUDGET_MS = 20_000
const DESTROY_BUDGET_MS = 10_000

const STOPPED: Desired = { running: false, until: 0, transitionZeroFix: false, aliasSalt: "" }

const message = (error: unknown) => (error instanceof Error ? error.name : "Error")

export class Lifecycle {
  /** Set while this object is ending the container, so its exit isn't counted as unplanned. */
  private expectingExit = false
  private exited: Promise<unknown> | undefined
  /** The boot id of the container this object started, once it answered. */
  private bootId: string | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private readonly host: Host
  private readonly budgets: {
    readonly start: number
    readonly exit: number
    readonly destroy: number
  }

  constructor(
    host: Host,
    budgets = { start: START_BUDGET_MS, exit: EXIT_BUDGET_MS, destroy: DESTROY_BUDGET_MS },
  ) {
    this.host = host
    this.budgets = budgets
  }

  /** Runs lifecycle changes one at a time. */
  private serial<A>(task: () => Promise<A>): Promise<A> {
    const run = this.queue.then(task, task)
    this.queue = run.catch(() => undefined)
    return run
  }

  async desired(): Promise<Desired> {
    return (await this.host.get<Desired>("desired")) ?? STOPPED
  }

  private async wanted(): Promise<boolean> {
    return alarmAction(await this.desired(), false, this.host.now()) === "restart"
  }

  start(hours: number, transitionZeroFix: boolean, aliasSalt: string) {
    return this.serial(async () => {
      const desired = await this.desired()
      if (desired.running && this.host.now() < desired.until) {
        return { error: `already running until ${new Date(desired.until).toISOString()}` }
      }
      if (this.host.container.running) {
        return { error: "the previous container is still running; POST /stop until it confirms" }
      }
      const until =
        this.host.now() + Math.min(Math.max(hours || DEFAULT_HOURS, 0.25), MAX_HOURS) * 3_600_000
      await this.host.put("desired", {
        running: true,
        until,
        transitionZeroFix,
        aliasSalt,
      } satisfies Desired)
      await this.host.setAlarm(this.host.now() + POLL_MS)
      const started = await this.ensureRunning("start")
      return { started, stopsAt: new Date(until).toISOString(), transitionZeroFix }
    })
  }

  /** Signals the container, waits for it to end, and starts it again within the same time limit. */
  restart(signal: 9 | 15, transitionZeroFix: boolean | undefined) {
    return this.serial(async () => {
      const desired = await this.desired()
      if (!(await this.wanted())) return { error: "the probe is not running; POST /start first" }
      if (transitionZeroFix !== undefined) {
        await this.host.put("desired", { ...desired, transitionZeroFix })
      }
      if (this.host.container.running) {
        const snapshot = await this.host.poll()
        this.host.record("disruption", {
          type: signal === 9 ? "sigkill" : "sigterm",
          bootId: this.bootId ?? snapshot?.bootId,
          present: snapshot?.presentUserIds ?? null,
        })
        if ((await this.end(signal)) === "running") return { error: "the container did not stop" }
      }
      return { started: await this.ensureRunning(`after signal ${signal}`) }
    })
  }

  /**
   * Marks the probe stopped at once, then ends the container. `stopped` is
   * true only once the container is confirmed off; otherwise the alarm keeps
   * trying.
   */
  async stop(reason: string) {
    const desired = await this.desired()
    if (desired.running) {
      await this.host.put("desired", { ...desired, running: false } satisfies Desired)
      this.host.record("stop-requested", { reason })
    }
    return this.serial(() => this.stopNow(reason))
  }

  private async stopNow(reason: string) {
    if (this.host.container.running) await this.host.poll()
    const stopped = (await this.end(15)) !== "running"
    if (stopped) {
      await this.host.deleteAlarm()
      this.host.record("stopped", { reason })
    } else {
      await this.host.setAlarm(this.host.now() + POLL_MS)
      this.host.record("error", { message: "the container is still running; retrying" })
    }
    return { stopped }
  }

  alarm() {
    return this.serial(async () => {
      const desired = await this.desired()
      const action = alarmAction(desired, this.host.container.running, this.host.now())
      if (action === "done") return
      try {
        if (action === "teardown") {
          if (desired.running) {
            await this.host.put("desired", { ...desired, running: false } satisfies Desired)
          }
          await this.stopNow(desired.running ? "time limit" : "retry")
          return
        }
        if (action === "poll") await this.host.poll()
        else if (!this.expectingExit) {
          // `live` is set once a container answered and cleared when this
          // object ends one, so a start that never came up isn't counted.
          if (await this.host.get<boolean>("live")) {
            this.host.record("disruption", { type: "unplanned-exit", bootId: this.bootId })
            await this.host.put("live", false)
          }
          await this.ensureRunning("restart after the container was gone")
        }
        await this.host.setAlarm(this.host.now() + POLL_MS)
      } catch (error) {
        this.host.record("error", { message: `alarm failed: ${message(error)}` })
        await this.host.setAlarm(this.host.now() + POLL_MS)
      }
    })
  }

  /**
   * Starts the container if the probe should run and it doesn't, and waits
   * until it answers. Gives up, and ends it, as soon as the probe is stopped.
   */
  private async ensureRunning(reason: string): Promise<boolean> {
    const container = this.host.container
    if (container.running) return true
    // Checked at the last moment: a stop may have arrived while this waited.
    if (!(await this.wanted())) return false
    const desired = await this.desired()
    try {
      container.start(desired)
    } catch (error) {
      // Right after a deploy there may be no instance yet; the next alarm tries again.
      this.host.record("error", { message: `start failed: ${message(error)}` })
      return false
    }
    this.expectingExit = false
    this.bootId = undefined
    let gone = false
    this.exited = container
      .monitor()
      .then(
        () => this.noteExit("exited"),
        () => this.noteExit("exited with an error"),
      )
      .finally(() => {
        gone = true
      })
    this.host.record("container-start", { reason, transitionZeroFix: desired.transitionZeroFix })
    const deadline = this.host.now() + this.budgets.start
    while (!gone && this.host.now() < deadline) {
      if (!(await this.wanted())) {
        await this.end(15)
        return false
      }
      const bootId = await container.health()
      if (bootId) {
        if (!(await this.wanted())) {
          await this.end(15)
          return false
        }
        this.bootId = bootId
        await this.host.put("live", true)
        return true
      }
      await this.host.sleep(500)
    }
    if (!gone) {
      this.host.record("error", { message: "the container did not answer /healthz within 60 s" })
    }
    return false
  }

  private noteExit(detail: string) {
    this.host.record("container-exit", {
      expected: this.expectingExit,
      bootId: this.bootId,
      detail,
    })
  }

  /** Ends the container and records how; "running" means it is still on. */
  private async end(signal: 9 | 15): Promise<EndOutcome> {
    this.expectingExit = true
    await this.host.put("live", false)
    const container = this.host.container
    const outcome = await endContainer(container, {
      signal,
      exited: this.exited ?? container.monitor(),
      exitMs: this.budgets.exit,
      destroyMs: this.budgets.destroy,
    })
    if (outcome !== "not running") {
      this.host.record("container-end", { signal, bootId: this.bootId, outcome })
    }
    return outcome
  }
}
