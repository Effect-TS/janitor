import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"
import { ALCHEMY_PHASE } from "alchemy/Phase"
import { requiredText } from "../Deployment.ts"

/** The Zero Trust organization whose GitHub identity provider admits people. */
export const TEAM_DOMAIN = "effectful.cloudflareaccess.com"
const GITHUB_ORGANIZATION = "Effectful-Tech"

/**
 * The Access application, declared on its own rather than owned by a Worker.
 * Two Workers serve this hostname, so the application protects the hostname
 * rather than a Worker destination: the edge decides before the request is
 * routed, which covers both. Owning it from either Worker would also make
 * the two reference each other.
 *
 * `alchemy dev` declares nothing here. There is no edge locally, so the
 * `dev.access` stub on the API Worker stands in for it.
 */
export const application = (domain: string, stage: string, identityProviderId: string) =>
  Cloudflare.Access.Application("Access", {
    type: "self_hosted",
    name: `Janitor ${stage}`,
    domain,
    sessionDuration: "8h",
    allowedIdps: [identityProviderId],
    autoRedirectToIdentity: true,
    policies: [
      {
        name: `${GITHUB_ORGANIZATION} members`,
        decision: "allow",
        include: [
          {
            githubOrganization: {
              identityProviderId,
              name: GITHUB_ORGANIZATION,
            },
          },
        ],
      },
    ],
  })

/**
 * GitHub cannot log in. A more specific application beats the broader one,
 * so this path skips Access and keeps its signature check.
 */
export const webhookBypass = (domain: string, stage: string) =>
  Cloudflare.Access.Application("WebhookBypass", {
    type: "self_hosted",
    name: `Janitor ${stage} GitHub webhooks`,
    domain: `${domain}/api/v1/webhooks/github`,
    appLauncherVisible: false,
    policies: [{ name: "GitHub deliveries", decision: "bypass", include: ["everyone"] }],
  })

export const slackWebhookBypass = (domain: string, stage: string) =>
  Cloudflare.Access.Application("SlackWebhookBypass", {
    type: "self_hosted",
    name: `Janitor ${stage} Slack webhooks`,
    domain: `${domain}/api/v1/webhooks/slack`,
    appLauncherVisible: false,
    policies: [{ name: "Signed Slack deliveries", decision: "bypass", include: ["everyone"] }],
  })

/** Provision Access only during deployment; runtime uses the ACCESS_AUD binding. */
export const declare = Effect.fnUntraced(function* (options: {
  readonly dev: boolean
  readonly domain: string
  readonly stage: string
}) {
  if (options.dev || (yield* ALCHEMY_PHASE) === "runtime") return undefined
  const identityProviderId = yield* requiredText("CLOUDFLARE_ACCESS_GITHUB_IDP_ID")
  const app = yield* application(options.domain, options.stage, identityProviderId)
  yield* webhookBypass(options.domain, options.stage)
  yield* slackWebhookBypass(options.domain, options.stage)
  return app
})
