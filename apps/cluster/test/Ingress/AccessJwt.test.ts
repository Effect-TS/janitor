import { assert, describe, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Deferred from "effect/Deferred"
import * as Fiber from "effect/Fiber"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Layer from "effect/Layer"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as AccessJwt from "../../src/Ingress/AccessJwt.ts"

const TEAM_DOMAIN = "team.cloudflareaccess.test"
const ISSUER = `https://${TEAM_DOMAIN}`
const AUDIENCE = "aud-janitor"

const generateKeyPair = Effect.promise(() =>
  crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: Uint8Array.from([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  ),
)

interface PublicJwk {
  readonly kid: string
  readonly kty: string
  readonly n: string
  readonly e: string
}

interface SigningKey {
  readonly kid: string
  readonly pair: CryptoKeyPair
  readonly jwk: PublicJwk
}

const makeSigningKey = (kid: string): Effect.Effect<SigningKey> =>
  Effect.gen(function* () {
    const pair = yield* generateKeyPair
    const jwk = yield* Effect.promise(() => crypto.subtle.exportKey("jwk", pair.publicKey))
    return { kid, pair, jwk: { kty: jwk.kty ?? "", n: jwk.n ?? "", e: jwk.e ?? "", kid } }
  })

const base64UrlJson = (value: unknown) =>
  Encoding.encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)))

const sign = (
  key: SigningKey,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "RS256", kid: key.kid, typ: "JWT" },
) =>
  Effect.gen(function* () {
    const input = `${base64UrlJson(header)}.${base64UrlJson(claims)}`
    const signature = yield* Effect.promise(() =>
      crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.pair.privateKey, new TextEncoder().encode(input)),
    )
    return `${input}.${Encoding.encodeBase64Url(new Uint8Array(signature))}`
  })

const nowSeconds = Effect.map(DateTime.now, (now) => Math.floor(DateTime.toEpochMillis(now) / 1000))

const validClaims = Effect.map(nowSeconds, (now) => ({
  iss: ISSUER,
  aud: [AUDIENCE],
  sub: "user-123",
  email: "person@example.com",
  iat: now,
  nbf: now,
  exp: now + 300,
}))

interface Certs {
  keys: Array<PublicJwk>
  fetches: number
}

const makeVerifier = (certs: Certs, config: Partial<AccessJwt.AccessVerifierConfig> = {}) => {
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      certs.fetches++
      assert.strictEqual(request.url, `${ISSUER}/cdn-cgi/access/certs`)
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify({ keys: certs.keys }), {
          headers: { "content-type": "application/json" },
        }),
      )
    }),
  )
  return AccessJwt.make({ teamDomain: TEAM_DOMAIN, audience: AUDIENCE, ...config }).pipe(
    Effect.provide(Layer.succeed(HttpClient.HttpClient, client)),
  )
}

const rejectionReason = (
  verification: Effect.Effect<
    AccessJwt.AccessIdentity,
    AccessJwt.AccessAssertionRejected | AccessJwt.AccessKeysUnavailable
  >,
) =>
  Effect.map(Effect.flip(verification), (error) =>
    error._tag === "AccessAssertionRejected" ? error.reason : error._tag,
  )

describe("AccessVerifier", () => {
  it.effect("does not make a cold request wait for another request's key fetch", () =>
    Effect.gen(function* () {
      const key = yield* makeSigningKey("kid-1")
      const firstStarted = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      let fetches = 0
      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          if (++fetches === 1) {
            yield* Deferred.succeed(firstStarted, undefined)
            yield* Deferred.await(releaseFirst)
          }
          return HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ keys: [key.jwk] })),
          )
        }),
      )
      const verifier = yield* AccessJwt.make({ teamDomain: TEAM_DOMAIN, audience: AUDIENCE }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      )
      const token = yield* sign(key, yield* validClaims)
      const first = yield* verifier.verify(token).pipe(Effect.forkChild)
      yield* Deferred.await(firstStarted)
      const second = yield* verifier.verify(token)
      assert.strictEqual(second.subject, "user-123")
      yield* Deferred.succeed(releaseFirst, undefined)
      yield* Fiber.join(first)
      yield* verifier.verify(token)
      assert.strictEqual(fetches, 2)
    }),
  )
  it.effect("accepts a valid assertion and returns issuer, subject, email, and expiry", () =>
    Effect.gen(function* () {
      const key = yield* makeSigningKey("kid-1")
      const certs: Certs = { keys: [key.jwk], fetches: 0 }
      const verifier = yield* makeVerifier(certs)
      const claims = yield* validClaims
      const identity = yield* verifier.verify(yield* sign(key, claims))
      assert.strictEqual(identity.issuer, ISSUER)
      assert.strictEqual(identity.subject, "user-123")
      assert.strictEqual(identity.email, "person@example.com")
      assert.strictEqual(DateTime.toEpochMillis(identity.expiresAt), claims.exp * 1000)
      // A string audience is accepted too, and the key set is reused.
      yield* verifier.verify(yield* sign(key, { ...claims, aud: AUDIENCE }))
      assert.strictEqual(certs.fetches, 1)
    }),
  )

  it.effect(
    "rejects a bad signature, wrong audience, wrong issuer, expiry, and empty subject",
    () =>
      Effect.gen(function* () {
        const key = yield* makeSigningKey("kid-1")
        const other = yield* makeSigningKey("kid-1")
        const certs: Certs = { keys: [key.jwk], fetches: 0 }
        const verifier = yield* makeVerifier(certs)
        const claims = yield* validClaims

        const cases: Array<[string, AccessJwt.AccessRejectionReason]> = [
          [yield* sign(other, claims), "invalid-signature"],
          [yield* sign(key, { ...claims, aud: ["someone-else"] }), "wrong-audience"],
          [
            yield* sign(key, { ...claims, iss: "https://other.cloudflareaccess.test" }),
            "unknown-issuer",
          ],
          [yield* sign(key, { ...claims, exp: claims.iat - 1 }), "expired"],
          [yield* sign(key, { ...claims, nbf: claims.iat + 3600 }), "not-yet-valid"],
          [yield* sign(key, { ...claims, sub: "  " }), "empty-subject"],
          [yield* sign(key, claims, { alg: "HS256", kid: key.kid }), "unsupported-algorithm"],
          [yield* sign(key, claims, { alg: "RS256" }), "malformed"],
          ["not-a-jwt", "malformed"],
          ["a.b", "malformed"],
        ]
        for (const [assertion, expected] of cases) {
          assert.strictEqual(yield* rejectionReason(verifier.verify(assertion)), expected)
        }
        // The foreign issuer never triggers a key fetch; the others share one.
        assert.strictEqual(certs.fetches, 1)
      }),
  )

  it.effect("refreshes once for an unknown kid from the known issuer", () =>
    Effect.gen(function* () {
      const old = yield* makeSigningKey("kid-old")
      const rotated = yield* makeSigningKey("kid-new")
      const certs: Certs = { keys: [old.jwk], fetches: 0 }
      const verifier = yield* makeVerifier(certs, { refreshCooldown: Duration.zero })
      const claims = yield* validClaims

      yield* verifier.verify(yield* sign(old, claims))
      assert.strictEqual(certs.fetches, 1)

      // Cloudflare rotated; the endpoint now lists the new key too.
      certs.keys = [old.jwk, rotated.jwk]
      const identity = yield* verifier.verify(yield* sign(rotated, claims))
      assert.strictEqual(identity.subject, "user-123")
      assert.strictEqual(certs.fetches, 2)

      // A kid the endpoint does not know is refused after exactly one refresh.
      const unknown = yield* makeSigningKey("kid-unknown")
      const reason = yield* rejectionReason(verifier.verify(yield* sign(unknown, claims)))
      assert.strictEqual(reason, "unknown-key")
      assert.strictEqual(certs.fetches, 3)
    }),
  )

  it.effect("does not refetch for an unknown kid inside the cooldown", () =>
    Effect.gen(function* () {
      const key = yield* makeSigningKey("kid-1")
      const unknown = yield* makeSigningKey("kid-unknown")
      const certs: Certs = { keys: [key.jwk], fetches: 0 }
      const verifier = yield* makeVerifier(certs)
      const claims = yield* validClaims
      yield* verifier.verify(yield* sign(key, claims))
      const reason = yield* rejectionReason(verifier.verify(yield* sign(unknown, claims)))
      assert.strictEqual(reason, "unknown-key")
      assert.strictEqual(certs.fetches, 1)
    }),
  )

  it.effect("fails with AccessKeysUnavailable when the certs endpoint is down", () =>
    Effect.gen(function* () {
      const key = yield* makeSigningKey("kid-1")
      const client = HttpClient.make((request) =>
        Effect.sync(() =>
          HttpClientResponse.fromWeb(request, new Response("nope", { status: 503 })),
        ),
      )
      const verifier = yield* AccessJwt.make({ teamDomain: TEAM_DOMAIN, audience: AUDIENCE }).pipe(
        Effect.provide(Layer.succeed(HttpClient.HttpClient, client)),
      )
      const reason = yield* rejectionReason(verifier.verify(yield* sign(key, yield* validClaims)))
      assert.strictEqual(reason, "AccessKeysUnavailable")
    }),
  )
})
