import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Output from "alchemy/Output"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

const hostname = "janitor-dev.effectful.co"

/**
 * Shared infrastructure for local development against the development GitHub
 * App. Deployed once with real Cloudflare credentials; `alchemy dev` never
 * plans it.
 */
export default Alchemy.Stack(
  "JanitorDevelopment",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const zoneId = yield* Config.schema(
      Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
      "CLOUDFLARE_ZONE_ID",
    )

    // Only the webhook route is public. Locally the API treats a request
    // without an Access assertion as the local-dev teammate, so any other
    // path through the tunnel would expose it to the internet.
    const tunnel = yield* Cloudflare.Tunnel.Tunnel("Webhooks", {
      name: "janitor-dev",
      ingress: [
        {
          hostname,
          path: "^/api/v1/webhooks/github$",
          service: "http://localhost:8787",
        },
        { service: "http_status:404" },
      ],
    })

    yield* Cloudflare.DNS.Record("WebhooksHostname", {
      zoneId,
      name: hostname,
      type: "CNAME",
      content: Output.interpolate`${tunnel.tunnelId}.cfargotunnel.com`,
      proxied: true,
      comment: "Janitor development GitHub App webhooks",
    })

    return {
      tunnelId: tunnel.tunnelId,
      webhookUrl: `https://${hostname}/api/v1/webhooks/github`,
    }
  }),
)
