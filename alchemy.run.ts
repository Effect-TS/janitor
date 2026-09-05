import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Command from "alchemy/Command"
import * as Docker from "alchemy/Docker"
import * as Neon from "alchemy/Neon"
import * as Provider from "alchemy/Provider"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import { JanitorDatabase } from "@janitor/cluster/Database"
import ClusterWorker from "@janitor/cluster/Worker"
import { deployment } from "@janitor/cluster/Deployment"
import { Stage } from "alchemy/Stage"

const WEBSITE_DEV_PORT = 1337

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
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const target = yield* deployment
    const stage = yield* Stage
    if (target.stage !== "local" && stage !== target.stage)
      return yield* Effect.die(new Error("JANITOR_STAGE must match the Alchemy --stage argument"))
    const database = yield* JanitorDatabase
    const cluster = yield* ClusterWorker

    const website = yield* Cloudflare.Website.Foldkit("Website", {
      rootDir: new URL("./apps/web", import.meta.url).pathname,
      ...(target.stage === "local" ? {} : { domain: target.domain }),
      workersDev: false,
      dev: { port: WEBSITE_DEV_PORT, strictPort: true },
    })

    return {
      databaseId: database.databaseId,
      apiUrl: cluster.url,
      url: website.url,
    }
  }),
)
