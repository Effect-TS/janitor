import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"

/**
 * Verifies the `Cf-Access-Jwt-Assertion` Cloudflare Access attaches to every
 * request it admits (design: "Authentication and authorization"). Access
 * already decided who may enter; this check makes sure a request actually
 * came through Access for this application, so a caller who reaches the
 * Worker some other way still gets nothing.
 */
export class AccessVerifier extends Context.Service<
  AccessVerifier,
  {
    readonly verify: (
      assertion: string,
    ) => Effect.Effect<AccessIdentity, AccessAssertionRejected | AccessKeysUnavailable>
  }
>()("@janitor/cluster/Ingress/AccessJwt/AccessVerifier") {}

/** The audit identity is issuer plus subject. Email is display only. */
export interface AccessIdentity {
  readonly issuer: string
  readonly subject: string
  readonly email: string | undefined
  readonly expiresAt: DateTime.Utc
}

export type AccessRejectionReason =
  | "malformed"
  | "unsupported-algorithm"
  | "unknown-issuer"
  | "unknown-key"
  | "invalid-signature"
  | "wrong-audience"
  | "expired"
  | "not-yet-valid"
  | "empty-subject"

/** The assertion is not acceptable. Never carries the assertion itself. */
export class AccessAssertionRejected extends Data.TaggedError("AccessAssertionRejected")<{
  readonly reason: AccessRejectionReason
  readonly cause?: unknown
}> {
  override get message(): string {
    return `Access assertion rejected: ${this.reason}`
  }
}

/** The team's signing keys could not be fetched or imported. */
export class AccessKeysUnavailable extends Data.TaggedError("AccessKeysUnavailable")<{
  readonly cause: unknown
}> {}

export interface AccessVerifierConfig {
  /** The Zero Trust team domain, e.g. `example.cloudflareaccess.com`. */
  readonly teamDomain: string
  /** The audience tag of the Access application that fronts this Worker. */
  readonly audience: string
  /** How long a fetched key set is trusted before it is fetched again. */
  readonly keyCacheTtl?: Duration.Duration
  /**
   * Minimum time between the fetch that produced the cached key set and a
   * refresh forced by an unknown `kid`, so arbitrary tokens cannot make the
   * Worker fetch keys on every request.
   */
  readonly refreshCooldown?: Duration.Duration
}

const DEFAULT_KEY_CACHE_TTL = Duration.hours(1)
const DEFAULT_REFRESH_COOLDOWN = Duration.minutes(1)
const NOT_BEFORE_SKEW_SECONDS = 60

const RSA_SIGNING = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const

const Header = Schema.Struct({
  alg: Schema.String,
  kid: Schema.NonEmptyString,
})

const Claims = Schema.Struct({
  iss: Schema.String,
  aud: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  exp: Schema.Finite,
  nbf: Schema.optionalKey(Schema.Finite),
  sub: Schema.String,
  email: Schema.optionalKey(Schema.String),
})

const Jwk = Schema.Struct({
  kid: Schema.NonEmptyString,
  kty: Schema.String,
  n: Schema.String,
  e: Schema.String,
})

const CertsResponse = Schema.Struct({
  body: Schema.Struct({ keys: Schema.Array(Jwk) }),
})

interface KeySet {
  readonly keys: ReadonlyMap<string, CryptoKey>
  readonly fetchedAt: DateTime.Utc
}

const rejected = (reason: AccessRejectionReason) => (cause: unknown) =>
  new AccessAssertionRejected({ reason, cause })

const decodeSegment = <S extends Schema.Top>(schema: S) => {
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(schema))
  return (segment: string) =>
    Effect.fromResult(Encoding.decodeBase64UrlString(segment)).pipe(
      Effect.flatMap(decode),
      Effect.mapError(rejected("malformed")),
    )
}

const decodeHeader = decodeSegment(Header)
const decodeClaims = decodeSegment(Claims)

export const make = Effect.fnUntraced(function* (config: AccessVerifierConfig) {
  const http = yield* HttpClient.HttpClient
  const issuer = `https://${config.teamDomain}`
  const certsUrl = `${issuer}/cdn-cgi/access/certs`
  const keyCacheTtl = config.keyCacheTtl ?? DEFAULT_KEY_CACHE_TTL
  const refreshCooldown = config.refreshCooldown ?? DEFAULT_REFRESH_COOLDOWN
  const decodeCerts = HttpClientResponse.schemaJson(CertsResponse)

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

  const fetchKeys: Effect.Effect<KeySet, AccessKeysUnavailable> = Effect.gen(function* () {
    const response = yield* http.get(certsUrl).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(decodeCerts),
      Effect.mapError((cause) => new AccessKeysUnavailable({ cause })),
    )
    const keys = new Map<string, CryptoKey>()
    for (const jwk of response.body.keys) {
      if (jwk.kty !== "RSA") continue
      // One unusable key must not take the whole set down with it.
      const key = yield* importKey(jwk).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Skipping an Access signing key WebCrypto rejected", cause).pipe(
            Effect.annotateLogs({ kid: jwk.kid }),
            Effect.as(undefined),
          ),
        ),
      )
      if (key !== undefined) keys.set(jwk.kid, key)
    }
    return { keys, fetchedAt: yield* DateTime.now }
  })

  let cached: KeySet | undefined
  const ageOf = (keySet: KeySet, now: DateTime.Utc) =>
    Duration.millis(DateTime.toEpochMillis(now) - DateTime.toEpochMillis(keySet.fetchedAt))

  // Share completed keys, never an in-flight request or semaphore. Worker
  // requests have separate I/O contexts; waiting on another request's fiber
  // can leave this request with no I/O of its own and workerd cancels it.
  const refresh = (seen: KeySet | undefined) =>
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
    // The issuer is ours, so an unknown kid most likely means a rotation.
    // Refresh once, unless the set was fetched a moment ago.
    if (Duration.isLessThan(ageOf(current, now), refreshCooldown)) {
      return yield* new AccessAssertionRejected({ reason: "unknown-key" })
    }
    const rotated = (yield* refresh(current)).keys.get(kid)
    if (rotated === undefined) {
      return yield* new AccessAssertionRejected({ reason: "unknown-key" })
    }
    return rotated
  })

  const verify = Effect.fn("AccessVerifier.verify")(function* (assertion: string) {
    const parts = assertion.split(".")
    if (parts.length !== 3) {
      return yield* new AccessAssertionRejected({ reason: "malformed" })
    }
    const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string]
    const header = yield* decodeHeader(encodedHeader)
    if (header.alg !== "RS256") {
      return yield* new AccessAssertionRejected({ reason: "unsupported-algorithm" })
    }
    const claims = yield* decodeClaims(encodedClaims)
    // Only the configured team's keys are ever fetched.
    if (claims.iss !== issuer) {
      return yield* new AccessAssertionRejected({ reason: "unknown-issuer" })
    }
    const signature = yield* Effect.fromResult(Encoding.decodeBase64Url(encodedSignature)).pipe(
      Effect.mapError(rejected("malformed")),
    )
    const key = yield* keyFor(header.kid)
    const valid = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.verify(
          RSA_SIGNING,
          key,
          new Uint8Array(signature),
          new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`),
        ),
      catch: rejected("invalid-signature"),
    })
    if (!valid) {
      return yield* new AccessAssertionRejected({ reason: "invalid-signature" })
    }
    const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud
    if (!audiences.includes(config.audience)) {
      return yield* new AccessAssertionRejected({ reason: "wrong-audience" })
    }
    const nowSeconds = Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1000)
    if (claims.exp <= nowSeconds) {
      return yield* new AccessAssertionRejected({ reason: "expired" })
    }
    if (claims.nbf !== undefined && claims.nbf > nowSeconds + NOT_BEFORE_SKEW_SECONDS) {
      return yield* new AccessAssertionRejected({ reason: "not-yet-valid" })
    }
    if (claims.sub.trim().length === 0) {
      return yield* new AccessAssertionRejected({ reason: "empty-subject" })
    }
    return {
      issuer: claims.iss,
      subject: claims.sub,
      email: claims.email,
      expiresAt: DateTime.makeUnsafe(claims.exp * 1000),
    } satisfies AccessIdentity
  })

  return { verify }
})

export const layerFrom = (
  config: AccessVerifierConfig,
): Layer.Layer<AccessVerifier, never, HttpClient.HttpClient> =>
  Layer.effect(AccessVerifier, make(config))
