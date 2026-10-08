import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Docker from "alchemy/Docker"
import * as Infisical from "alchemy/Infisical"
import * as Provider from "alchemy/Provider"
import { localState } from "alchemy/State"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import ExecutorContainerLive from "./src/ExecutorContainer.runtime.ts"
import SpikeWorker from "./src/Worker.ts"

const DockerProviders = Layer.effect(
  Docker.Providers,
  Provider.collection([Docker.Container, Docker.Image]),
).pipe(
  Layer.provide([Docker.ContainerProvider(), Docker.ImageProvider()]),
  Layer.provideMerge(Docker.DockerLive),
)

export default Alchemy.Stack(
  "Eff1655Spike",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), DockerProviders),
    state: localState(),
    // Optional: janitor's development secrets (OPENROUTER_API_KEY) for the
    // real-model turn. Everything else in the spike works without them.
    secrets: () => [Infisical.Secrets({ project: "janitor", environment: "development" })],
  },
  Effect.gen(function* () {
    const worker = yield* SpikeWorker
    return { url: worker.url }
  }).pipe(Effect.provide(ExecutorContainerLive)),
)
