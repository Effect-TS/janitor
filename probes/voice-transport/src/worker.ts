/**
 * The voice transport probe's control plane: a Worker, behind a bearer
 * token, and one Durable Object that owns the probe container. The object
 * starts the container, collects its events every 15 seconds into SQLite so
 * they outlive restarts, restarts it if it exits, and ends it at a fixed time
 * limit. Ending is retried by alarm until the container is confirmed off, and
 * the container exits on its own shortly after the limit as a backstop. See
 * README.md for the runbook.
 */
import { DurableObject } from "cloudflare:workers"
import { type Desired, alarmAction, endContainer, within } from "./lifecycle.ts"
import { type ProbeEvent, renderMarkdown, summarize } from "./report.ts"

interface Env {
  readonly PROBE: DurableObjectNamespace<VoiceProbe>
  readonly PROBE_TOKEN?: string
  readonly DISCORD_BOT_TOKEN?: string
  readonly DISCORD_GUILD_ID?: string
  readonly DISCORD_CHANNEL_ID?: string
}

const PORT = 8080
const POLL_MS = 15_000
const DEFAULT_HOURS = 3
const MAX_HOURS = 6
/** The container's own deadline is this long after the object's time limit. */
const CONTAINER_MARGIN_MS = 2 * 60_000
const START_BUDGET_MS = 60_000
const EXIT_BUDGET_MS = 20_000
const DESTROY_BUDGET_MS = 10_000
const REQUEST_BUDGET_MS = 5_000

const json = (body: unknown) => {
  const status =
    typeof body === "object" && body !== null && "error" in body
      ? 409
      : typeof body === "object" && body !== null && "stopped" in body && body.stopped === false
        ? 503
        : 200
  return new Response(JSON.stringify(body, null, 2) + "\n", {
    status,
    headers: { "content-type": "application/json" },
  })
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const message = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 200)

const authorized = (request: Request, expected: string | undefined): boolean => {
  if (!expected) return false
  const given = new TextEncoder().encode(request.headers.get("authorization") ?? "")
  const wanted = new TextEncoder().encode(`Bearer ${expected}`)
  return given.byteLength === wanted.byteLength && crypto.subtle.timingSafeEqual(given, wanted)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!authorized(request, env.PROBE_TOKEN)) {
      return new Response('{ "error": "unauthorized" }\n', { status: 401 })
    }
    const url = new URL(request.url)
    const probe = env.PROBE.get(env.PROBE.idFromName("probe"))
    const flag = (name: string) => {
      const value = url.searchParams.get(name)
      return value === null ? undefined : value === "on"
    }
    switch (`${request.method} ${url.pathname}`) {
      case "POST /start":
        return json(
          await probe.start(
            Number(url.searchParams.get("hours") ?? DEFAULT_HOURS),
            flag("fix") ?? false,
          ),
        )
      case "GET /status":
        return json(await probe.status())
      case "GET /report": {
        const report = summarize(await probe.events())
        return url.searchParams.get("format") === "json"
          ? json(report)
          : new Response(renderMarkdown(report), {
              headers: { "content-type": "text/markdown; charset=utf-8" },
            })
      }
      case "GET /events":
        return json(await probe.events())
      case "POST /drop":
        return json(await probe.forward("/drop"))
      case "POST /rejoin":
        return json(await probe.forward("/rejoin"))
      case "POST /stun":
        return json(await probe.forward("/stun"))
      case "POST /restart":
        return json(
          await probe.restart(url.searchParams.get("signal") === "kill" ? 9 : 15, flag("fix")),
        )
      case "POST /stop":
        return json(await probe.stop("operator"))
      case "POST /reset":
        return json(await probe.reset())
      default:
        return new Response('{ "error": "not found" }\n', { status: 404 })
    }
  },
} satisfies ExportedHandler<Env>

export class VoiceProbe extends DurableObject<Env> {
  /** Set while this object is ending the container, so its exit isn't counted as unplanned. */
  private expectingExit = false
  private exited: Promise<void> | undefined

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, body TEXT NOT NULL)",
    )
  }

  private get container(): Container {
    const container = this.ctx.container
    if (!container) throw new Error("no container is attached to this Durable Object")
    return container
  }

  private record(kind: string, detail: Record<string, unknown> = {}) {
    const event = { at: Date.now(), kind, source: "object", ...detail }
    this.ctx.storage.sql.exec(
      "INSERT INTO events (at, body) VALUES (?, ?)",
      event.at,
      JSON.stringify(event),
    )
  }

  private async desired(): Promise<Desired> {
    return (
      (await this.ctx.storage.get<Desired>("desired")) ?? {
        running: false,
        until: 0,
        transitionZeroFix: false,
      }
    )
  }

  async start(hours: number, transitionZeroFix: boolean) {
    const missing = ["DISCORD_BOT_TOKEN", "DISCORD_GUILD_ID", "DISCORD_CHANNEL_ID"].filter(
      (name) => !this.env[name as keyof Env],
    )
    if (missing.length > 0) return { error: `missing secrets: ${missing.join(", ")}` }
    const desired = await this.desired()
    if (desired.running && Date.now() < desired.until) {
      return { error: `already running until ${new Date(desired.until).toISOString()}` }
    }
    if (this.container.running) {
      return { error: "the previous container is still running; POST /stop until it confirms" }
    }
    const until =
      Date.now() + Math.min(Math.max(hours || DEFAULT_HOURS, 0.25), MAX_HOURS) * 3_600_000
    await this.ctx.storage.put("desired", {
      running: true,
      until,
      transitionZeroFix,
    } satisfies Desired)
    await this.ctx.storage.setAlarm(Date.now() + POLL_MS)
    const started = await this.ensureRunning("start")
    return { started, stopsAt: new Date(until).toISOString(), transitionZeroFix }
  }

  async status() {
    const desired = await this.desired()
    const running = this.container.running
    const live = running ? await this.poll() : undefined
    return { desired, running, live: live ?? null, recent: (await this.events()).slice(-40) }
  }

  async events(): Promise<Array<ProbeEvent>> {
    return this.ctx.storage.sql
      .exec<{ body: string }>("SELECT body FROM events ORDER BY id")
      .toArray()
      .map((row) => JSON.parse(row.body) as ProbeEvent)
  }

  async forward(path: string) {
    if (!this.container.running) return { error: "the probe is not running" }
    const body = await within(
      this.container
        .getTcpPort(PORT)
        .fetch(`http://container${path}`, { method: "POST" })
        .then((response) => response.json()),
      REQUEST_BUDGET_MS,
    )
    await this.poll()
    return body ?? { error: "the container did not answer" }
  }

  /** Signals the container, waits for it to exit, and starts it again within the same time limit. */
  async restart(signal: 9 | 15, transitionZeroFix: boolean | undefined) {
    const desired = await this.desired()
    if (alarmAction(desired, true, Date.now()) !== "poll") {
      return { error: "the probe is not running; POST /start first" }
    }
    if (transitionZeroFix !== undefined) {
      await this.ctx.storage.put("desired", { ...desired, transitionZeroFix })
    }
    if (this.container.running) {
      await this.poll()
      this.record("disruption", { type: signal === 9 ? "sigkill" : "sigterm" })
      if (!(await this.end(signal))) return { error: "the container did not stop" }
    }
    return { started: await this.ensureRunning(`after signal ${signal}`) }
  }

  /**
   * Marks the probe stopped and ends the container. Answers `stopped: false`
   * (HTTP 503) unless the container is confirmed off; the alarm keeps trying.
   */
  async stop(reason: string) {
    const desired = await this.desired()
    if (desired.running) {
      await this.ctx.storage.put("desired", { ...desired, running: false } satisfies Desired)
      this.record("stop-requested", { reason })
    }
    if (this.container.running) await this.poll()
    const stopped = await this.end(15)
    if (stopped) {
      await this.ctx.storage.deleteAlarm()
      this.record("stopped", { reason })
    } else {
      await this.ctx.storage.setAlarm(Date.now() + POLL_MS)
      this.record("error", { message: "the container is still running; retrying" })
    }
    return { stopped }
  }

  async reset() {
    if ((await this.desired()).running || this.container.running) {
      return { error: "stop the probe first" }
    }
    this.ctx.storage.sql.exec("DELETE FROM events")
    await this.ctx.storage.delete("cursor")
    return { reset: true }
  }

  override async alarm() {
    const action = alarmAction(await this.desired(), this.container.running, Date.now())
    if (action === "done") return
    try {
      if (action === "teardown") {
        await this.stop((await this.desired()).running ? "time limit" : "retry")
        return
      }
      if (action === "poll") await this.poll()
      else if (!this.expectingExit) {
        // `live` is set once a container answered and cleared when this
        // object ends one, so a start that never came up isn't counted.
        if (await this.ctx.storage.get<boolean>("live")) {
          this.record("disruption", { type: "unplanned-exit" })
          await this.ctx.storage.put("live", false)
        }
        await this.ensureRunning("restart after the container was gone")
      }
      await this.ctx.storage.setAlarm(Date.now() + POLL_MS)
    } catch (error) {
      this.record("error", { message: `alarm failed: ${message(error)}` })
      await this.ctx.storage.setAlarm(Date.now() + POLL_MS)
    }
  }

  /** Starts the container unless it runs, and waits until it answers. */
  private async ensureRunning(reason: string): Promise<boolean> {
    const container = this.container
    if (container.running) return true
    const desired = await this.desired()
    try {
      container.start({
        enableInternet: true,
        env: {
          DISCORD_BOT_TOKEN: this.env.DISCORD_BOT_TOKEN ?? "",
          DISCORD_GUILD_ID: this.env.DISCORD_GUILD_ID ?? "",
          DISCORD_CHANNEL_ID: this.env.DISCORD_CHANNEL_ID ?? "",
          TRANSITION_ZERO_FIX: desired.transitionZeroFix ? "1" : "0",
          STOP_AT: String(desired.until + CONTAINER_MARGIN_MS),
          PORT: String(PORT),
        },
      })
    } catch (error) {
      // Right after a deploy there may be no instance yet; the next alarm tries again.
      this.record("error", { message: `start failed: ${message(error)}` })
      return false
    }
    this.expectingExit = false
    let gone = false
    this.exited = container
      .monitor()
      .then(
        () => this.noteExit("exited"),
        (error: unknown) => this.noteExit(message(error)),
      )
      .finally(() => {
        gone = true
      })
    this.record("container-start", { reason, transitionZeroFix: desired.transitionZeroFix })
    // Containers sleep after a while without requests to the object; the
    // alarm's polls keep it awake, and this ends it soon after polls stop.
    await within(container.setInactivityTimeout(10 * 60_000), REQUEST_BUDGET_MS)
    const deadline = Date.now() + START_BUDGET_MS
    while (!gone && Date.now() < deadline) {
      const response = await within(
        container.getTcpPort(PORT).fetch("http://container/healthz"),
        REQUEST_BUDGET_MS,
      )
      if (response?.ok) {
        await this.ctx.storage.put("live", true)
        return true
      }
      await sleep(500)
    }
    if (!gone) {
      this.record("error", { message: "the container did not answer /healthz within 60 s" })
    }
    return false
  }

  private noteExit(detail: string) {
    this.record("container-exit", { expected: this.expectingExit, detail })
  }

  /** Ends the container; true once it is confirmed off. */
  private async end(signal: 9 | 15): Promise<boolean> {
    this.expectingExit = true
    await this.ctx.storage.put("live", false)
    return endContainer(this.container, {
      signal,
      exited: this.exited ?? this.container.monitor(),
      exitMs: EXIT_BUDGET_MS,
      destroyMs: DESTROY_BUDGET_MS,
    })
  }

  /** Copies the container's new events, and a snapshot, into storage. Bounded; never throws. */
  private async poll(): Promise<unknown> {
    const cursor = (await this.ctx.storage.get<{ bootId: string; seq: number }>("cursor")) ?? {
      bootId: "",
      seq: 0,
    }
    const body = await within(
      this.container
        .getTcpPort(PORT)
        .fetch(`http://container/events?boot=${cursor.bootId}&after=${cursor.seq}`)
        .then(
          (response) =>
            response.json() as Promise<{
              bootId: string
              events: Array<{ seq: number; at: number }>
              snapshot: Record<string, unknown>
            }>,
        ),
      REQUEST_BUDGET_MS,
    )
    if (!body) {
      this.record("error", { message: "poll failed or timed out" })
      return undefined
    }
    for (const event of body.events) {
      this.ctx.storage.sql.exec(
        "INSERT INTO events (at, body) VALUES (?, ?)",
        event.at,
        JSON.stringify(event),
      )
    }
    const last = body.events.at(-1)
    if (last) await this.ctx.storage.put("cursor", { bootId: body.bootId, seq: last.seq })
    this.ctx.storage.sql.exec(
      "INSERT INTO events (at, body) VALUES (?, ?)",
      Date.now(),
      JSON.stringify({ kind: "snapshot", ...body.snapshot, at: Date.now() }),
    )
    return body.snapshot
  }
}
