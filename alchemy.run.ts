import * as Config from "effect/Config"
import { localState } from "alchemy/State"
import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Command from "alchemy/Command"
import * as Docker from "alchemy/Docker"
import * as Infisical from "alchemy/Infisical"
import * as Neon from "alchemy/Neon"
import * as Provider from "alchemy/Provider"
import * as Secrets from "alchemy/Secrets"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"

import { JanitorDatabase } from "@janitor/cluster/Database"
import ClusterWorker from "@janitor/cluster/Worker"
import { deployment } from "@janitor/cluster/Deployment"

const DockerProviders = Layer.effect(
  Docker.Providers,
  Provider.collection([Docker.Container, Docker.Image]),
).pipe(
  Layer.provide([Docker.ContainerProvider(), Docker.ImageProvider()]),
  Layer.provideMerge(Docker.DockerLive),
)

const Providers = Layer.mergeAll(
  Cloudflare.providers(),
  Command.providers(),
  DockerProviders,
  Neon.providers(),
)

export default Alchemy.Stack(
  "Janitor",
  {
    providers: Providers,
    state: Layer.unwrap(
      Alchemy.ALCHEMY_DEV.pipe(
        Effect.orDie,
        Effect.map((dev) => (dev ? localState() : Cloudflare.state())),
      ),
    ),
    // Production configuration lives in Infisical and overrides the shell, which
    // supplies only Cloudflare credentials and Infisical's own login. Development
    // reads the shared optional integrations from Infisical, pins the emulator
    // identity from local.env over them, and lets the shell override both.
    secrets: ({ stage }) =>
      stage === "production"
        ? [
            Secrets.ProcessEnv(),
            Infisical.Secrets({ project: "janitor", environment: "production" }),
          ]
        : [
            Infisical.Secrets({ project: "janitor", environment: "development" }),
            Secrets.DotEnv({ path: "deployment/local.env" }),
          ],
  },
  Effect.gen(function* () {
    const target = yield* deployment
    const database = yield* JanitorDatabase
    const cluster = yield* ClusterWorker

    // Connects the development GitHub App's webhook tunnel (stacks/development.ts)
    // when Infisical supplies its token. Only one connector should run at a
    // time: Cloudflare splits deliveries between concurrent ones.
    if (target.stage === "local") {
      const tunnelToken = yield* Config.option(Config.Redacted("CLOUDFLARE_TUNNEL_TOKEN"))
      if (Option.isSome(tunnelToken)) {
        yield* Command.Dev("WebhookTunnel", {
          command: "cloudflared tunnel --no-autoupdate run",
          env: { TUNNEL_TOKEN: tunnelToken.value },
        })
      }
    }

    const website = yield* Cloudflare.Website.Foldkit("Website", {
      rootDir: new URL("./apps/web", import.meta.url).pathname,
      ...(target.stage === "local" ? {} : { domain: target.domain }),
      workersDev: false,
      dev: {
        port: yield* Config.Int("JANITOR_LOCAL_WEB_PORT").pipe(Config.withDefault(1337)),
        strictPort: true,
      },
    })

    return {
      databaseId: database.databaseId,
      apiUrl: cluster.url,
      url: website.url,
    }
  }),
)
