/**
 * The voice transport probe's control plane: a Worker, behind a bearer
 * token, and one Durable Object that owns the probe container. The object
 * starts the container, collects its events every 15 seconds into SQLite so
 * they outlive restarts, restarts it if it exits, and ends it at a fixed time
 * limit. The lifecycle decisions live in lifecycle.ts. Ending is retried by
 * alarm until the container is confirmed off, and the container exits on its
 * own shortly after the limit as a backstop. See README.md for the runbook.
 */
import { DurableObject } from "cloudflare:workers"
import { Lifecycle, within } from "./lifecycle.ts"
import { type ProbeEvent, renderMarkdown, summarize } from "./report.ts"

interface Env {
  readonly PROBE: DurableObjectNamespace<VoiceProbe>
  readonly PROBE_TOKEN?: string
  readonly DISCORD_BOT_TOKEN?: string
  readonly DISCORD_GUILD_ID?: string
  readonly DISCORD_CHANNEL_ID?: string
}

const PORT = 8080
const DEFAULT_HOURS = 3
/** The container's own deadline is this long after the object's time limit. */
const CONTAINER_MARGIN_MS = 2 * 60_000
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

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
  private readonly lifecycle: Lifecycle

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, body TEXT NOT NULL)",
    )
    const storage = ctx.storage
    const container = () => {
      const attached = ctx.container
      if (!attached) throw new Error("no container is attached to this Durable Object")
      return attached
    }
    this.lifecycle = new Lifecycle({
      container: {
        get running() {
          return container().running
        },
        signal: (signo) => container().signal(signo),
        destroy: () => container().destroy(),
        monitor: () => container().monitor(),
        start: (desired) => {
          container().start({
            enableInternet: true,
            env: {
              DISCORD_BOT_TOKEN: env.DISCORD_BOT_TOKEN ?? "",
              DISCORD_GUILD_ID: env.DISCORD_GUILD_ID ?? "",
              DISCORD_CHANNEL_ID: env.DISCORD_CHANNEL_ID ?? "",
              TRANSITION_ZERO_FIX: desired.transitionZeroFix ? "1" : "0",
              STOP_AT: String(desired.until + CONTAINER_MARGIN_MS),
              ALIAS_SALT: desired.aliasSalt,
              PORT: String(PORT),
            },
          })
          // Containers sleep after a while without requests to the object; the
          // alarm's polls keep it awake, and this ends it soon after polls stop.
          void within(container().setInactivityTimeout(10 * 60_000), REQUEST_BUDGET_MS)
        },
        health: async () => {
          const body = await within(
            container()
              .getTcpPort(PORT)
              .fetch("http://container/healthz")
              .then((response) => response.json() as Promise<{ bootId?: unknown }>),
            REQUEST_BUDGET_MS,
          )
          return typeof body?.bootId === "string" ? body.bootId : undefined
        },
      },
      now: () => Date.now(),
      sleep,
      get: (key) => storage.get(key),
      put: (key, value) => storage.put(key, value),
      setAlarm: (at) => storage.setAlarm(at),
      deleteAlarm: () => storage.deleteAlarm(),
      record: (kind, detail) => this.record(kind, detail),
      poll: () => this.poll(),
    })
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

  async start(hours: number, transitionZeroFix: boolean) {
    const missing = ["DISCORD_BOT_TOKEN", "DISCORD_GUILD_ID", "DISCORD_CHANNEL_ID"].filter(
      (name) => !this.env[name as keyof Env],
    )
    if (missing.length > 0) return { error: `missing secrets: ${missing.join(", ")}` }
    return this.lifecycle.start(hours || DEFAULT_HOURS, transitionZeroFix, crypto.randomUUID())
  }

  async status() {
    const desired = await this.lifecycle.desired()
    const running = this.container.running
    const live = running ? await this.poll() : undefined
    return {
      desired: {
        running: desired.running,
        until: desired.until,
        transitionZeroFix: desired.transitionZeroFix,
      },
      running,
      live: live ?? null,
      recent: (await this.events()).slice(-40),
    }
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

  restart(signal: 9 | 15, transitionZeroFix: boolean | undefined) {
    return this.lifecycle.restart(signal, transitionZeroFix)
  }

  /** Answers `stopped: false` (HTTP 503) unless the container is confirmed off; the alarm keeps trying. */
  stop(reason: string) {
    return this.lifecycle.stop(reason)
  }

  async reset() {
    if ((await this.lifecycle.desired()).running || this.container.running) {
      return { error: "stop the probe first" }
    }
    this.ctx.storage.sql.exec("DELETE FROM events")
    await this.ctx.storage.delete("cursor")
    return { reset: true }
  }

  override async alarm() {
    await this.lifecycle.alarm()
  }

  /** Copies the container's new events, and a snapshot, into storage. Bounded; never throws. */
  private async poll(): Promise<Record<string, unknown> | undefined> {
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
