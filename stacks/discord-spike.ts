import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Infisical from "alchemy/Infisical"
import * as Effect from "effect/Effect"
import DiscordSpikeWorker from "@janitor/cluster/Chat/Discord/SpikeWorker"

/**
 * The Discord gateway spike (EFF-3020): one Worker hosting the gateway
 * Durable Object, on a temporary stage, against the dev Discord app whose
 * token Infisical's development environment holds. Torn down once the 24
 * hours are measured.
 *
 * ```sh
 * DISCORD_GATEWAY_SPIKE_TOKEN=<random> vp exec alchemy deploy stacks/discord-spike.ts --stage spike --profile dev
 * vp exec alchemy destroy stacks/discord-spike.ts --stage spike --profile dev
 * ```
 */
export default Alchemy.Stack(
  "JanitorDiscordSpike",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
    secrets: Infisical.Secrets({ project: "janitor", environment: "development" }),
  },
  Effect.gen(function* () {
    const worker = yield* DiscordSpikeWorker
    return { url: worker.url }
  }),
)
