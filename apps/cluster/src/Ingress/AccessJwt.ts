import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as HttpClient from "effect/unstable/http/HttpClient"
import * as Jwks from "./Jwks.ts"

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

const NOT_BEFORE_SKEW_SECONDS = 60

const Claims = Schema.Struct({
  iss: Schema.String,
  aud: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  exp: Schema.Finite,
  nbf: Schema.optionalKey(Schema.Finite),
  sub: Schema.String,
  email: Schema.optionalKey(Schema.String),
})

const decodeClaims = Schema.decodeUnknownEffect(Claims)

const rejected = (reason: AccessRejectionReason) => (cause: unknown) =>
  new AccessAssertionRejected({ reason, cause })

export const make = Effect.fnUntraced(function* (config: AccessVerifierConfig) {
  const issuer = `https://${config.teamDomain}`
  const keys = yield* Jwks.makeKeySet({
    url: `${issuer}/cdn-cgi/access/certs`,
    keyCacheTtl: config.keyCacheTtl,
    refreshCooldown: config.refreshCooldown,
  })

  const verify = Effect.fn("AccessVerifier.verify")(function* (assertion: string) {
    const token = yield* Jwks.parseCompact(assertion).pipe(Effect.mapError(rejected("malformed")))
    if (token.header.alg !== "RS256") {
      return yield* new AccessAssertionRejected({ reason: "unsupported-algorithm" })
    }
    const claims = yield* decodeClaims(token.claims).pipe(Effect.mapError(rejected("malformed")))
    // Only the configured team's keys are ever fetched.
    if (claims.iss !== issuer) {
      return yield* new AccessAssertionRejected({ reason: "unknown-issuer" })
    }
    const key = yield* keys.keyFor(token.header.kid).pipe(
      Effect.catchTags({
        UnknownKey: () => new AccessAssertionRejected({ reason: "unknown-key" }),
        KeysUnavailable: (error) => new AccessKeysUnavailable({ cause: error.cause }),
      }),
    )
    if (!(yield* Jwks.verifyRs256(key, token.signingInput, token.signature))) {
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
