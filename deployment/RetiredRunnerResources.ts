import * as Cloudflare from "alchemy/Cloudflare"
import { Effect, Layer } from "effect"

/** Alchemy requires a provider even to forget a resource marked retain.
 * Keep this registration until all deployed stages have retired AgentSandboxImage.
 * It cannot build, publish or delete an image.
 */
export const cloudflareProviders = () =>
  Layer.effect(
    Cloudflare.Providers,
    Effect.gen(function* () {
      const providers = yield* Cloudflare.Providers
      providers.providers["Janitor.RunnerImage"] = {
        list: () => Effect.succeed([]),
        reconcile: () => Effect.die(new Error("Runner images have been retired")),
        delete: () =>
          Effect.die(new Error("Retired runner images must retain their physical resource")),
      }
      return providers
    }),
  ).pipe(Layer.provideMerge(Cloudflare.providers()))
