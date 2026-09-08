import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as GitHub from "alchemy/GitHub"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const repository = {
  owner: "Effect-TS",
  repository: "janitor",
}

export default Alchemy.Stack(
  "JanitorGitHub",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment

    const zoneId = yield* Config.schema(
      Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
      "CLOUDFLARE_ZONE_ID",
    )

    const environment = yield* GitHub.Environment("Production", {
      ...repository,
      name: "production",
      deploymentBranchPolicy: { customBranchPolicies: ["main"] },
    })

    const token = yield* Cloudflare.ApiToken.AccountApiToken("ProductionDeployToken", {
      accountId,
      policies: [
        {
          effect: "allow",
          resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
          permissionGroups: [
            "Account Settings Read",
            "Workers Scripts Write",
            "Workers R2 Storage Write",
            "Queues Write",
            "Hyperdrive Write",
            "Secrets Store Write",
            // The name is ambiguous between account and zone scopes in Cloudflare's catalog.
            { id: "1e13c5124ca64b72b1969a67e8829049" }, // Access: Apps and Policies Write (account)
            "Access: Organizations, Identity Providers, and Groups Read",
          ],
        },
        {
          effect: "allow",
          resources: {
            [`com.cloudflare.api.account.${accountId}`]: {
              [`com.cloudflare.api.account.zone.${zoneId}`]: "*",
            },
          },
          permissionGroups: ["Zone Read", "Workers Routes Write"],
        },
      ],
    })

    yield* GitHub.Secret("CloudflareToken", {
      ...repository,
      environment,
      name: "CLOUDFLARE_API_TOKEN",
      value: token.value,
    })

    yield* GitHub.Variable("CloudflareAccount", {
      ...repository,
      environment,
      name: "CLOUDFLARE_ACCOUNT_ID",
      value: accountId,
    })
  }),
)
