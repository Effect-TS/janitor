import * as AlchemyCloudflareCluster from "@effect/platform-cloudflare/AlchemyCloudflareCluster"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Cause from "effect/Cause"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import WorkspaceObjectLive, { WorkspaceObject } from "./WorkspaceObject.ts"
import { DeployMarker, OpenRouterKey, ReviewRun, WorkspaceNamespace, WorkspaceStubs, makeReviewRunLayer, type Transport } from "./ReviewRun.ts"

/**
 * HTTP front door for the smoke test. Every route takes `?run=<id>`.
 */
export default class StagingWorker extends Cloudflare.Worker<StagingWorker>()(
  "Eff1847Worker",
  Effect.gen(function* () {
    const marker = yield* Config.String("DEPLOY_MARKER").pipe(Config.withDefault("unset"))
    const executorUrl = yield* Config.String("EXECUTOR_URL")
    return {
      main: import.meta.url,
      // janitor production values, minus `limits: { cpuMs: 300_000 }`: the
      // staging account is on the Free plan, which rejects CPU limits.
      compatibility: { date: "2026-09-05", flags: ["nodejs_compat"] },
      workersDev: true,
      observability: { enabled: true, headSamplingRate: 1 },
      env: { DEPLOY_MARKER: marker, EXECUTOR_URL: executorUrl },
    }
  }),
  Effect.gen(function* () {
    const workspaces = yield* WorkspaceObject.pipe(Effect.provide(WorkspaceObjectLive))
    const openRouterKey = yield* Config.Redacted("OPENROUTER_API_KEY")
    const marker = yield* Config.String("DEPLOY_MARKER").pipe(Config.withDefault("unset"))
    const env = yield* Cloudflare.Workers.WorkerEnvironment

    const cluster = yield* AlchemyCloudflareCluster.make({
      entities: [ReviewRun],
      layer: Layer.unwrap(makeReviewRunLayer).pipe(
        Layer.provide([
          Layer.succeed(WorkspaceNamespace, (env as any).Eff1847Workspace),
          Layer.succeed(WorkspaceStubs, workspaces as any),
          Layer.succeed(OpenRouterKey, openRouterKey),
          Layer.succeed(DeployMarker, marker),
        ]),
      ),
    })

    const handler = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const url = new URL(request.url, "http://localhost")
      const runId = url.searchParams.get("run") ?? "default"
      const transport = (url.searchParams.get("transport") ?? "http") as Transport
      const num = (name: string, fallback: number) => Number(url.searchParams.get(name) ?? fallback)
      const json = (value: unknown) => HttpServerResponse.jsonUnsafe(value)
      const client = yield* ReviewRun.client
      const run = client(runId)
      const started = Date.now()
      const timed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.map((result) => ({ deploy: marker, wallMs: Date.now() - started, result })))
      switch (url.pathname) {
        case "/start":
          return json(
            yield* timed(
              run.Start({
                runId,
                minutes: num("minutes", 12),
                model: url.searchParams.get("model") ?? "openai/gpt-4.1-mini",
                sleepSeconds: num("sleep", 10),
                transport,
              }),
            ),
          )
        case "/status":
          return json(yield* timed(run.Status()))
        case "/cancel":
          return json(yield* timed(run.Cancel({ runId, reason: url.searchParams.get("reason") ?? "smoke" })))
        case "/publish": {
          // A persisted tell: the reply is not awaited.
          yield* run.Publish({ runId, steps: num("steps", 8), stepSeconds: num("stepSeconds", 30) }, { discard: true })
          return json({ deploy: marker, sent: true })
        }
        case "/probe":
          return json(yield* timed(run.Probe({ kind: url.searchParams.get("kind") ?? "caps", transport, n: num("n", 3) })))
        case "/workspace":
          return json(yield* timed(workspaces.getByName(runId).status()))
        case "/workspace/release":
          return json(yield* timed(workspaces.getByName(runId).release()))
        case "/version":
          return json({ deploy: marker })
        default:
          return HttpServerResponse.text(
            "routes: /start?minutes=&model=&sleep=&transport= /status /cancel /publish?steps=&stepSeconds= /probe?kind=caps|concurrent|interrupt&n= /workspace /workspace/release /version  (?run=<id>)",
            { status: 404 },
          )
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.succeed(HttpServerResponse.jsonUnsafe({ deploy: marker, error: Cause.pretty(cause).slice(0, 4000) }, { status: 500 })),
      ),
    )

    return { fetch: cluster.provide(handler) }
  }),
) {}
