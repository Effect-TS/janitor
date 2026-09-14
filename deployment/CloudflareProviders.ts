import * as Cloudflare from "alchemy/Cloudflare"
import type * as Provider from "alchemy/Provider"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

const withoutPrecreate = (provider: Provider.ProviderService): Provider.ProviderService => {
  const { precreate: _precreate, ...rest } = provider
  return rest
}

/**
 * Alchemy beta.76 precreates Containers before resolving image Outputs.
 * Our Worker already precreates its Durable Object namespaces, so the
 * Container can wait for those namespaces and the published image instead.
 */
export const cloudflareProviders = () =>
  Layer.effect(
    Cloudflare.Providers,
    Effect.gen(function* () {
      const original = yield* Cloudflare.Providers
      const container = original.get("Cloudflare.Container")
      if (!container) return yield* Effect.die(new Error("Missing Cloudflare Container provider"))
      original.providers["Cloudflare.Container"] = {
        ...withoutPrecreate(container),
        ...(container.modes === undefined
          ? {}
          : {
              modes: {
                ...container.modes,
                live: container.modes.live.pipe(Effect.map(withoutPrecreate)),
              },
            }),
      }
      return original
    }),
  ).pipe(Layer.provideMerge(Cloudflare.providers()))
