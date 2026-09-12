import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"

/**
 * RS256 key sets published as JWKS, shared by the Access assertion check and
 * the Slack ID token check. Keys are cached and refreshed once on an unknown
 * `kid`, with a cooldown so arbitrary tokens cannot force a fetch per request.
 */

/** The key set could not be fetched or imported. */
export class KeysUnavailable extends Data.TaggedError("KeysUnavailable")<{
  readonly cause: unknown
}> {}

/** The issuer does not publish a key with this `kid`, even after a refresh. */
export class UnknownKey extends Data.TaggedError("UnknownKey")<{
  readonly kid: string
}> {}

/** The token is not three base64url segments with a usable header. */
export class MalformedToken extends Data.TaggedError("MalformedToken")<{
  readonly cause?: unknown
}> {}

export interface KeySetConfig {
  /** Where the issuer publishes its JWKS. */
  readonly url: string
  /** How long a fetched key set is trusted before it is fetched again. */
  readonly keyCacheTtl?: Duration.Duration | undefined
  /**
   * Minimum time between the fetch that produced the cached key set and a
   * refresh forced by an unknown `kid`.
   */
  readonly refreshCooldown?: Duration.Duration | undefined
}

export interface KeySet {
  readonly keyFor: (kid: string) => Effect.Effect<CryptoKey, KeysUnavailable | UnknownKey>
}

const DEFAULT_KEY_CACHE_TTL = Duration.hours(1)
const DEFAULT_REFRESH_COOLDOWN = Duration.minutes(1)

export const RSA_SIGNING = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const

const Jwk = Schema.Struct({
  kid: Schema.NonEmptyString,
  kty: Schema.String,
  n: Schema.String,
  e: Schema.String,
})

const KeysResponse = Schema.Struct({
  body: Schema.Struct({ keys: Schema.Array(Jwk) }),
})

interface Fetched {
  readonly keys: ReadonlyMap<string, CryptoKey>
  readonly fetchedAt: DateTime.Utc
}

export const makeKeySet = Effect.fnUntraced(function* (config: KeySetConfig) {
  const http = yield* HttpClient.HttpClient
  const keyCacheTtl = config.keyCacheTtl ?? DEFAULT_KEY_CACHE_TTL
  const refreshCooldown = config.refreshCooldown ?? DEFAULT_REFRESH_COOLDOWN
  const decodeKeys = HttpClientResponse.schemaJson(KeysResponse)

  const importKey = (jwk: typeof Jwk.Type) =>
    Effect.tryPromise(() =>
      crypto.subtle.importKey(
        "jwk",
        { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
        RSA_SIGNING,
        false,
        ["verify"],
      ),
    )

  const fetchKeys: Effect.Effect<Fetched, KeysUnavailable> = Effect.gen(function* () {
    const response = yield* http.get(config.url).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(decodeKeys),
      Effect.mapError((cause) => new KeysUnavailable({ cause })),
    )
    const keys = new Map<string, CryptoKey>()
    for (const jwk of response.body.keys) {
      if (jwk.kty !== "RSA") continue
      // One unusable key must not take the whole set down with it.
      const key = yield* importKey(jwk).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Skipping a signing key WebCrypto rejected", cause).pipe(
            Effect.annotateLogs({ kid: jwk.kid, url: config.url }),
            Effect.as(undefined),
          ),
        ),
      )
      if (key !== undefined) keys.set(jwk.kid, key)
    }
    return { keys, fetchedAt: yield* DateTime.now }
  })

  let cached: Fetched | undefined
  const ageOf = (fetched: Fetched, now: DateTime.Utc) =>
    Duration.millis(DateTime.toEpochMillis(now) - DateTime.toEpochMillis(fetched.fetchedAt))

  // Share completed keys, never an in-flight request or semaphore. Worker
  // requests have separate I/O contexts; waiting on another request's fiber
  // can leave this request with no I/O of its own and workerd cancels it.
  const refresh = (seen: Fetched | undefined) =>
    Effect.gen(function* () {
      if (cached !== undefined && cached !== seen) return cached
      const fresh = yield* fetchKeys
      cached = fresh
      return fresh
    })

  const keyFor = Effect.fnUntraced(function* (kid: string) {
    const now = yield* DateTime.now
    const current =
      cached !== undefined && Duration.isLessThan(ageOf(cached, now), keyCacheTtl)
        ? cached
        : yield* refresh(cached)
    const key = current.keys.get(kid)
    if (key !== undefined) return key
    // An unknown kid from a trusted issuer most likely means a rotation.
    // Refresh once, unless the set was fetched a moment ago.
    if (Duration.isLessThan(ageOf(current, now), refreshCooldown)) {
      return yield* new UnknownKey({ kid })
    }
    const rotated = (yield* refresh(current)).keys.get(kid)
    if (rotated === undefined) {
      return yield* new UnknownKey({ kid })
    }
    return rotated
  })

  const keySet: KeySet = { keyFor }
  return keySet
})

const Header = Schema.Struct({
  alg: Schema.String,
  kid: Schema.NonEmptyString,
})

const decodeSegment = <S extends Schema.Top>(schema: S) => {
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(schema))
  return (segment: string) =>
    Effect.fromResult(Encoding.decodeBase64UrlString(segment)).pipe(
      Effect.flatMap(decode),
      Effect.mapError((cause) => new MalformedToken({ cause })),
    )
}

const decodeHeader = decodeSegment(Header)
const decodeClaims = decodeSegment(Schema.Unknown)

export interface CompactToken {
  readonly header: typeof Header.Type
  /** Decoded JSON; callers apply their own claims schema. */
  readonly claims: unknown
  readonly signingInput: string
  readonly signature: Uint8Array
}

/** Splits a compact JWS without trusting any of it yet. */
export const parseCompact = (token: string): Effect.Effect<CompactToken, MalformedToken> =>
  Effect.gen(function* () {
    const parts = token.split(".")
    if (parts.length !== 3) {
      return yield* new MalformedToken({})
    }
    const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string]
    const header = yield* decodeHeader(encodedHeader)
    const claims = yield* decodeClaims(encodedClaims)
    const signature = yield* Effect.fromResult(Encoding.decodeBase64Url(encodedSignature)).pipe(
      Effect.mapError((cause) => new MalformedToken({ cause })),
    )
    return { header, claims, signingInput: `${encodedHeader}.${encodedClaims}`, signature }
  })

/** True when `signature` is a valid RS256 signature of `signingInput` under `key`. */
export const verifyRs256 = (
  key: CryptoKey,
  signingInput: string,
  signature: Uint8Array,
): Effect.Effect<boolean> =>
  Effect.promise(() =>
    crypto.subtle.verify(
      RSA_SIGNING,
      key,
      new Uint8Array(signature),
      new TextEncoder().encode(signingInput),
    ),
  ).pipe(Effect.orElseSucceed(() => false))
