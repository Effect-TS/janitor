import * as Cloudflare from "alchemy/Cloudflare"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Redacted from "effect/Redacted"
import {
  ChatDiscordGateway,
  ChatDiscordGatewayLive,
  discordGatewayConfig,
  GATEWAY_NAME,
} from "./Gateway.ts"

/**
 * The Discord gateway spike's Worker (EFF-3020): hosts the gateway Durable
 * Object alone, on a temporary stage, with its stats readable over HTTP.
 * `DISCORD_GATEWAY_SPIKE_TOKEN` guards every route. Deployed by
 * `stacks/discord-spike.ts`; not part of the production stack.
 */
export default class DiscordSpikeWorker extends Cloudflare.Worker<DiscordSpikeWorker>()(
  "DiscordSpikeWorker",
  Effect.succeed({
    main: import.meta.url,
    compatibility: { date: "2026-09-05", flags: ["nodejs_compat"] },
    workersDev: true,
    observability: { enabled: true, headSamplingRate: 1 },
  }),
  Effect.gen(function* () {
    // Read at init, so alchemy binds the secrets the object reads at runtime.
    yield* discordGatewayConfig
    const spikeToken = yield* Config.Redacted("DISCORD_GATEWAY_SPIKE_TOKEN")
    const gateways = yield* ChatDiscordGateway.pipe(Effect.provide(ChatDiscordGatewayLive))

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (request.headers["authorization"] !== `Bearer ${Redacted.value(spikeToken)}`)
          return HttpServerResponse.empty({ status: 401 })
        const url = new URL(request.url, "https://spike.internal")
        const gateway = gateways.getByName(GATEWAY_NAME)
        switch (`${request.method} ${url.pathname}`) {
          case "POST /start":
            yield* gateway.start()
            return HttpServerResponse.empty({ status: 204 })
          case "POST /stop":
            yield* gateway.stop()
            return HttpServerResponse.empty({ status: 204 })
          case "POST /reset":
            return HttpServerResponse.empty({ status: (yield* gateway.reset()) ? 204 : 409 })
          case "GET /stats":
            return HttpServerResponse.jsonUnsafe(yield* gateway.stats())
          case "GET /events":
            return HttpServerResponse.jsonUnsafe(
              yield* gateway.events({
                after: Number(url.searchParams.get("after") ?? 0),
                limit: Number(url.searchParams.get("limit") ?? 1000),
              }),
            )
          default:
            return HttpServerResponse.empty({ status: 404 })
        }
      }).pipe(Effect.orDie),
    }
  }),
) {}
