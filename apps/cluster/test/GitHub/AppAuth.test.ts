import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { GitHubInstallationId } from "@janitor/domain/GitHub/Id"
import * as AppAuth from "../../src/GitHub/AppAuth.ts"

const pem = (label: string, der: Uint8Array) =>
  `-----BEGIN ${label}-----
${Encoding.encodeBase64(der).replace(/(.{64})/g, "$1\n")}\n-----END ${label}-----\n`

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

/** Extracts the PKCS#1 body from a PKCS#8 DER so the wrapper can be tested. */
const pkcs1FromPkcs8 = (pkcs8: Uint8Array): Uint8Array => {
  // SEQUENCE(len) INTEGER 0 (3 bytes) SEQUENCE algid (15 bytes) OCTET STRING(len) ...
  let offset = 1
  const skipLength = () => {
    const first = pkcs8[offset++] ?? 0
    if (first & 0x80) offset += first & 0x7f
  }
  skipLength()
  offset += 3 + 15
  assert.strictEqual(pkcs8[offset], 0x04)
  offset += 1
  skipLength()
  return pkcs8.slice(offset)
}

const decodeBase64Url = (value: string) => {
  const result = Encoding.decodeBase64Url(value)
  assert.isTrue(result._tag === "Success")
  return result._tag === "Success" ? result.success : new Uint8Array()
}

describe("GitHubAppAuth", () => {
  it.effect("signs an RS256 JWT for the App that verifies with the public key", () =>
    Effect.gen(function* () {
      const pair = yield* generateKeyPair
      const der = new Uint8Array(
        yield* Effect.promise(() => crypto.subtle.exportKey("pkcs8", pair.privateKey)),
      )
      let tokenCalls = 0
      const auth = yield* AppAuth.make({
        appId: "12345",
        privateKey: Redacted.make(pem("PRIVATE KEY", der)),
      }).pipe(
        Effect.provide(
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.sync(() => {
                tokenCalls++
                return HttpClientResponse.fromWeb(request, new Response("{}"))
              }),
            ),
          ),
        ),
      )

      const jwt = Redacted.value(yield* auth.appJwt)
      const [header, payload, signature] = jwt.split(".")
      assert.isDefined(header)
      assert.isDefined(payload)
      assert.isDefined(signature)
      if (header === undefined || payload === undefined || signature === undefined) return

      const decodedHeader: unknown = JSON.parse(new TextDecoder().decode(decodeBase64Url(header)))
      const decodedPayload: unknown = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload)))
      assert.deepStrictEqual(decodedHeader, { alg: "RS256", typ: "JWT" })
      assert.isTrue(typeof decodedPayload === "object" && decodedPayload !== null)
      if (typeof decodedPayload !== "object" || decodedPayload === null) return
      assert.strictEqual(Reflect.get(decodedPayload, "iss"), "12345")
      const iat = Reflect.get(decodedPayload, "iat")
      const exp = Reflect.get(decodedPayload, "exp")
      assert.isTrue(typeof iat === "number" && typeof exp === "number" && exp - iat === 600)

      const verified = yield* Effect.promise(() =>
        crypto.subtle.verify(
          "RSASSA-PKCS1-v1_5",
          pair.publicKey,
          new Uint8Array(decodeBase64Url(signature)),
          new TextEncoder().encode(`${header}.${payload}`),
        ),
      )
      assert.isTrue(verified)
      assert.strictEqual(tokenCalls, 0)

      // The JWT is reused while it is fresh.
      assert.strictEqual(Redacted.value(yield* auth.appJwt), jwt)
    }),
  )

  it.effect("accepts the PKCS#1 PEM that GitHub downloads", () =>
    Effect.gen(function* () {
      const pair = yield* generateKeyPair
      const pkcs8 = new Uint8Array(
        yield* Effect.promise(() => crypto.subtle.exportKey("pkcs8", pair.privateKey)),
      )
      const pkcs1 = pkcs1FromPkcs8(pkcs8)

      assert.deepStrictEqual(AppAuth.pkcs1ToPkcs8(pkcs1), pkcs8)

      const fromPem = yield* AppAuth.privateKeyDer(pem("RSA PRIVATE KEY", pkcs1))
      assert.deepStrictEqual(fromPem, pkcs8)
    }),
  )

  it.effect("accepts a PEM flattened to one line with literal newline escapes", () =>
    Effect.gen(function* () {
      const pair = yield* generateKeyPair
      const der = new Uint8Array(
        yield* Effect.promise(() => crypto.subtle.exportKey("pkcs8", pair.privateKey)),
      )
      const flattened = pem("PRIVATE KEY", der).replace(/\n/g, "\\n")

      assert.deepStrictEqual(yield* AppAuth.privateKeyDer(flattened), der)
    }),
  )

  it.effect("rejects keys that are not PEM or not RSA", () =>
    Effect.gen(function* () {
      const notPem = yield* AppAuth.privateKeyDer("nope").pipe(Effect.exit)
      const wrongType = yield* AppAuth.privateKeyDer(
        "-----BEGIN EC PRIVATE KEY-----\nAA==\n-----END EC PRIVATE KEY-----",
      ).pipe(Effect.exit)
      assert.isTrue(Exit.isFailure(notPem))
      assert.isTrue(Exit.isFailure(wrongType))
    }),
  )

  it.effect(
    "exchanges the JWT for a cached installation token and refreshes after invalidation",
    () =>
      Effect.gen(function* () {
        const pair = yield* generateKeyPair
        const der = new Uint8Array(
          yield* Effect.promise(() => crypto.subtle.exportKey("pkcs8", pair.privateKey)),
        )
        const requests: Array<{
          url: string
          authorization: string | undefined
          version: string | undefined
          userAgent: string | undefined
        }> = []
        let issued = 0
        const client = HttpClient.make((request) =>
          Effect.sync(() => {
            requests.push({
              url: request.url,
              authorization: request.headers["authorization"],
              version: request.headers["x-github-api-version"],
              userAgent: request.headers["user-agent"],
            })
            issued++
            const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
            return HttpClientResponse.fromWeb(
              request,
              new Response(
                JSON.stringify({ token: `ghs_token_${issued}`, expires_at: expiresAt }),
                {
                  status: 201,
                  headers: { "content-type": "application/json" },
                },
              ),
            )
          }),
        )
        const auth = yield* AppAuth.make({
          appId: "1",
          privateKey: Redacted.make(pem("PRIVATE KEY", der)),
        }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, client)))
        const installationId = GitHubInstallationId.make("789")

        const first = yield* auth.installationToken(installationId)
        const second = yield* auth.installationToken(installationId)
        yield* auth.invalidateInstallationToken(installationId)
        const third = yield* auth.installationToken(installationId)

        assert.strictEqual(Redacted.value(first), "ghs_token_1")
        assert.strictEqual(Redacted.value(second), "ghs_token_1")
        assert.strictEqual(Redacted.value(third), "ghs_token_2")
        assert.strictEqual(requests.length, 2)
        assert.strictEqual(
          requests[0]?.url,
          "https://api.github.com/app/installations/789/access_tokens",
        )
        assert.isTrue(requests[0]?.authorization?.startsWith("Bearer ey"))
        assert.strictEqual(requests[0]?.version, "2022-11-28")
        assert.strictEqual(requests[0]?.userAgent, "janitor")
      }),
  )
})
