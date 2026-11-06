import * as Clock from "effect/Clock"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"

/**
 * Attio's OAuth credential (EFF-3443). Attio's MCP server takes short-lived
 * access tokens, issued for one Attio member by the `refresh_token` grant.
 * This swaps a refresh token for them, ahead of expiry and one refresh at a
 * time, and keeps the refresh token up to date in storage when Attio
 * rotates it. A singleton Durable Object holds it, so every session shares
 * one refresh token (`AttioCredentialObject.ts`).
 *
 * No token, refresh token or client secret is ever logged or put in an
 * error.
 */

/** No access token now: none configured, Attio refused, or a refresh failed. */
export class AttioUnavailable extends Schema.TaggedError<AttioUnavailable>()(
  "AttioUnavailable",
  {},
) {}

export interface AttioCredential {
  /**
   * An access token with more than five minutes left. `rejected` is a token
   * Attio answered 401 to: if it's still the current one, it's replaced.
   */
  readonly token: (
    rejected?: Redacted.Redacted<string>,
  ) => Effect.Effect<Redacted.Redacted<string>, AttioUnavailable>
}

export interface AttioCredentialOptions {
  readonly clientId: string
  readonly clientSecret: Option.Option<Redacted.Redacted<string>>
  /** The refresh token from the consent, configured in Infisical: the seed. */
  readonly refreshToken: Redacted.Redacted<string>
  readonly tokenUrl: string
  /** The MCP server's URL, sent as `resource`, as MCP's authorisation spec asks. */
  readonly resource: string
  /** Where the current refresh token survives a restart. */
  readonly storage: {
    readonly load: Effect.Effect<unknown, unknown>
    readonly save: (value: unknown) => Effect.Effect<void, unknown>
  }
}

/**
 * A token is reused only while more than this is left of it. With Attio's
 * hour-long tokens that is a refresh every 55 minutes. A token that lives
 * this long or less, which is what an answer without `expires_in` is taken
 * to, is refreshed on every call.
 */
const REFRESH_WINDOW = Duration.minutes(5)
/** How long a token without `expires_in` is taken to live. */
const DEFAULT_LIFETIME = Duration.minutes(5)
const REQUEST_TIMEOUT = Duration.seconds(15)
/** After a failed refresh, how long calls fail without asking Attio again. */
const BACKOFF = Duration.seconds(30)

/**
 * What storage holds. `seedHash` names the configured refresh token the rest
 * descends from: a new consent, deployed as a new seed, starts over.
 */
const Stored = Schema.Struct({
  seedHash: Schema.String,
  refreshToken: Schema.String,
  needsConsent: Schema.Boolean,
})
type Stored = typeof Stored.Type

const decodeStored = Schema.decodeUnknownEffect(Stored)

const TokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  expires_in: Schema.optional(Schema.Finite),
  refresh_token: Schema.optional(Schema.NonEmptyString),
})
const decodeTokenResponse = Schema.decodeUnknownEffect(TokenResponse)

const ErrorResponse = Schema.Struct({ error: Schema.String })
const decodeErrorResponse = Schema.decodeUnknownEffect(ErrorResponse)

/** The OAuth errors that mean the refresh token or client is gone for good. */
const CONSENT_ERRORS = new Set(["invalid_grant", "invalid_client"])

const sha256 = (value: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).pipe(
    Effect.map((digest) =>
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    ),
  )

interface Cached {
  readonly token: string
  readonly expiresAt: number
}

/** Why a refresh failed: for the log, never with content. */
type Failure =
  | { readonly _tag: "Consent"; readonly error: string }
  | { readonly _tag: "Transient"; readonly reason: string }

const transient = (reason: string): Failure => ({ _tag: "Transient", reason })

export const makeAttioCredential = (
  options: AttioCredentialOptions,
): Effect.Effect<AttioCredential, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const seed = Redacted.value(options.refreshToken)
    // Hashed here, once, so no refresh waits on it.
    const seedHash = yield* sha256(seed)

    /** The refresh token and consent state, once read from storage. */
    let state: Stored | undefined
    let cached: Cached | undefined
    let failedAt: number | undefined
    let inflight: Deferred.Deferred<Redacted.Redacted<string>, AttioUnavailable> | undefined

    /** Storage's state, or the seed's when storage is empty, unreadable or from another seed. */
    const load = Effect.suspend(() =>
      state !== undefined
        ? Effect.succeed(state)
        : options.storage.load.pipe(
            Effect.flatMap((value) => decodeStored(value)),
            Effect.map((stored) => (stored.seedHash === seedHash ? stored : undefined)),
            Effect.orElseSucceed(() => undefined),
            Effect.map((stored) => {
              state = stored ?? { seedHash, refreshToken: seed, needsConsent: false }
              return state
            }),
          ),
    )

    const save = (next: Stored) =>
      Effect.suspend(() => {
        state = next
        return options.storage.save(next)
      }).pipe(Effect.mapError(() => transient("storage")))

    /** One `refresh_token` grant, with the current refresh token. */
    const exchange = (refreshToken: string) =>
      HttpClientRequest.post(options.tokenUrl).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.bodyUrlParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: options.clientId,
          resource: options.resource,
          ...Option.match(options.clientSecret, {
            onNone: () => ({}),
            onSome: (secret) => ({ client_secret: Redacted.value(secret) }),
          }),
        }),
        http.execute,
        Effect.flatMap((response) =>
          response.status >= 200 && response.status < 300
            ? response.json.pipe(
                Effect.flatMap(decodeTokenResponse),
                Effect.mapError(() => transient("malformed")),
              )
            : response.json.pipe(
                Effect.flatMap(decodeErrorResponse),
                Effect.option,
                Effect.flatMap((body) =>
                  Effect.fail<Failure>(
                    Option.isSome(body) && CONSENT_ERRORS.has(body.value.error)
                      ? { _tag: "Consent", error: body.value.error }
                      : transient(`status ${response.status}`),
                  ),
                ),
              ),
        ),
        Effect.scoped,
        Effect.timeoutOrElse({
          duration: REQUEST_TIMEOUT,
          orElse: () => Effect.fail(transient("timeout")),
        }),
        Effect.catchTag("HttpClientError", () => Effect.fail(transient("network"))),
      )

    /** Refreshes the access token, storing a rotated refresh token before handing it out. */
    const refresh: Effect.Effect<Redacted.Redacted<string>, AttioUnavailable> = Effect.gen(
      function* () {
        const current = yield* load
        if (current.needsConsent) return yield* new AttioUnavailable()
        const granted = yield* exchange(current.refreshToken)
        if (granted.refresh_token !== undefined && granted.refresh_token !== current.refreshToken)
          yield* save({ seedHash, refreshToken: granted.refresh_token, needsConsent: false })
        const now = yield* Clock.currentTimeMillis
        const lifetime =
          granted.expires_in === undefined
            ? Duration.toMillis(DEFAULT_LIFETIME)
            : granted.expires_in * 1000
        cached = { token: granted.access_token, expiresAt: now + lifetime }
        failedAt = undefined
        return Redacted.make(granted.access_token)
      },
    ).pipe(
      Effect.catchIf(
        (error): error is Failure => error._tag !== "AttioUnavailable",
        (failure) =>
          Effect.gen(function* () {
            cached = undefined
            if (failure._tag === "Consent") {
              yield* Effect.logError(
                "Attio refused the refresh token; Attio stays off until a new consent is deployed",
              ).pipe(Effect.annotateLogs({ error: failure.error }))
              const current = yield* load
              yield* save({ ...current, needsConsent: true }).pipe(Effect.ignore)
            } else {
              failedAt = yield* Clock.currentTimeMillis
              yield* Effect.logWarning("Couldn't refresh Attio's access token").pipe(
                Effect.annotateLogs({ reason: failure.reason }),
              )
            }
            return yield* new AttioUnavailable()
          }),
      ),
    )

    const token = (rejected?: Redacted.Redacted<string>) =>
      Effect.gen(function* () {
        if (inflight !== undefined) return yield* Deferred.await(inflight)
        if (state?.needsConsent) return yield* new AttioUnavailable()
        const now = yield* Clock.currentTimeMillis
        if (
          cached !== undefined &&
          cached.expiresAt - now > Duration.toMillis(REFRESH_WINDOW) &&
          (rejected === undefined || Redacted.value(rejected) !== cached.token)
        )
          return Redacted.make(cached.token)
        if (failedAt !== undefined && now - failedAt < Duration.toMillis(BACKOFF))
          return yield* new AttioUnavailable()

        // The refresh runs on its own fiber, so a caller giving up never
        // leaves the others waiting or a rotated refresh token unstored.
        const done = Deferred.makeUnsafe<Redacted.Redacted<string>, AttioUnavailable>()
        inflight = done
        yield* refresh.pipe(
          Effect.exit,
          Effect.flatMap((exit) =>
            Effect.suspend(() => {
              inflight = undefined
              return Deferred.done(done, exit)
            }),
          ),
          Effect.forkDetach,
        )
        return yield* Deferred.await(done)
      })

    return { token }
  })
