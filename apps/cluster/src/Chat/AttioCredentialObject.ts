import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/http/HttpClient"
import { promise } from "../PullRequestReview/Sandbox/Container.ts"
import { attioSettings } from "./Attio.ts"
import { type AttioCredential, AttioUnavailable, makeAttioCredential } from "./AttioCredential.ts"

/**
 * Attio's credential's Durable Object: one instance, named `CREDENTIAL_NAME`,
 * holding the refresh token for every session, so refreshes across sessions
 * and isolates happen one at a time, here. The class is always declared, like
 * the chat pool's, so turning Attio off never takes a migration that deletes
 * its storage; without Attio's settings it answers `AttioUnavailable`.
 *
 * Tokens cross the RPC boundary as plain strings: `Redacted` keeps its value
 * out of the object, so it wouldn't survive serialisation. Both sides wrap
 * them again at once.
 */

export const CREDENTIAL_NAME = "attio"

export interface AttioCredentialShape {
  /** `rejected` is the token Attio answered 401 to, if any; see `AttioCredential.token`. */
  readonly token: (input: {
    readonly rejected: string | null
  }) => Effect.Effect<string, AttioUnavailable>
}

export class AttioCredentialObject extends Cloudflare.DurableObject<
  AttioCredentialObject,
  AttioCredentialShape
>()("AttioCredential", { errors: [AttioUnavailable] }) {}

/** The part of the Durable Object's storage the credential uses. */
interface CredentialStorage {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
}

const STORAGE_KEY = "credential"

const isUnavailable = Schema.is(AttioUnavailable)

export const AttioCredentialLive = AttioCredentialObject.make(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState
    const http = yield* HttpClient.HttpClient

    return Effect.gen(function* () {
      const storage = state.raw.storage as unknown as CredentialStorage
      const settings = yield* attioSettings.pipe(Effect.orElseSucceed(() => Option.none()))
      const credential = yield* Option.match(settings, {
        onNone: () => Effect.succeed(Option.none<AttioCredential>()),
        onSome: (settings) =>
          makeAttioCredential({
            clientId: settings.clientId,
            clientSecret: settings.clientSecret,
            refreshToken: settings.refreshToken,
            tokenUrl: settings.tokenUrl,
            resource: settings.url,
            storage: {
              load: promise(() => storage.get<unknown>(STORAGE_KEY)),
              save: (value) => promise(() => storage.put(STORAGE_KEY, value)),
            },
          }).pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.map(Option.some)),
      })

      return {
        token: ({ rejected }: { readonly rejected: string | null }) =>
          Option.match(credential, {
            onNone: () => Effect.fail(new AttioUnavailable()),
            onSome: (credential) =>
              credential
                .token(rejected === null ? undefined : Redacted.make(rejected))
                .pipe(Effect.map(Redacted.value)),
          }),
      }
    })
  }),
)

/**
 * The Worker's side: `AttioCredential` over the object's RPC. A failed call,
 * a reset object or a deploy in progress included, is `AttioUnavailable`, so
 * the turn goes on without Attio.
 */
export const attioCredentialFrom = (objects: {
  readonly getByName: (name: string) => AttioCredentialShape
}): AttioCredential => ({
  token: (rejected) =>
    Effect.suspend(() =>
      objects
        .getByName(CREDENTIAL_NAME)
        .token({ rejected: rejected === undefined ? null : Redacted.value(rejected) }),
    ).pipe(
      Effect.map((token) => Redacted.make(token)),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
        const error = Cause.findErrorOption(cause)
        return Option.isSome(error) && isUnavailable(error.value)
          ? Effect.fail(error.value)
          : Effect.logWarning("Couldn't reach Attio's credential").pipe(
              Effect.andThen(Effect.fail(new AttioUnavailable())),
            )
      }),
    ),
})
