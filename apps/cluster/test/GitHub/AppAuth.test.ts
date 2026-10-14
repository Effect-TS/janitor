import { assert, describe, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Base64 from "effect/encoding/Base64"
import * as Base64Url from "effect/encoding/Base64Url"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Redacted from "effect/Redacted"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { GitHubInstallationId } from "@janitor/domain/GitHub/Id"
import * as AppAuth from "../../src/GitHub/AppAuth.ts"

const pem = (label: string, der: Uint8Array) =>
  `-----BEGIN ${label}-----
${Base64.encode(der).replace(/(.{64})/g, "$1\n")}\n-----END ${label}-----\n`

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
  const result = Base64Url.decode(value)
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

  it.effect(
    "mints a contents-read token for one repository and revokes it without exposing it",
    () =>
      Effect.gen(function* () {
        const pair = yield* generateKeyPair
        const der = new Uint8Array(
          yield* Effect.promise(() => crypto.subtle.exportKey("pkcs8", pair.privateKey)),
        )
        const secret = "ghs_sandbox_secret_value"
        const requests: Array<{
          method: string
          url: string
          authorization?: string
          body: unknown
        }> = []
        let revoked = false
        const client = HttpClient.make((request) =>
          Effect.sync(() => {
            const body = request.body._tag === "Uint8Array" ? request.body.body : undefined
            requests.push({
              method: request.method,
              url: request.url,
              ...(request.headers["authorization"] === undefined
                ? {}
                : { authorization: request.headers["authorization"] }),
              body: body === undefined ? undefined : JSON.parse(new TextDecoder().decode(body)),
            })
            if (request.method === "DELETE") {
              // A revoked token is no longer a credential.
              const status = revoked ? 401 : 204
              revoked = true
              return HttpClientResponse.fromWeb(
                request,
                status === 204
                  ? new Response(null, { status })
                  : new Response(JSON.stringify({ message: "Bad credentials" }), { status }),
              )
            }
            return HttpClientResponse.fromWeb(
              request,
              new Response(
                JSON.stringify({
                  token: secret,
                  expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
                }),
                { status: 201, headers: { "content-type": "application/json" } },
              ),
            )
          }),
        )
        const logs: Array<string> = []
        const capture = Logger.make((options) => {
          logs.push(Logger.formatJson.log(options))
        })
        const auth = yield* AppAuth.make({
          appId: "1",
          privateKey: Redacted.make(pem("PRIVATE KEY", der)),
        }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, client)))

        const token = yield* auth.installationToken(GitHubInstallationId.make("789"), {
          repositoryId: "701",
          contents: "read",
        })
        yield* auth.revokeInstallationToken(token)
        const failure = yield* auth
          .revokeInstallationToken(token)
          .pipe(Effect.flip, Effect.provide(Logger.layer([capture])))

        assert.deepStrictEqual(
          requests.map(({ method, url, body }) => ({ method, url, body })),
          [
            {
              method: "POST",
              url: "https://api.github.com/app/installations/789/access_tokens",
              body: { repository_ids: [701], permissions: { contents: "read" } },
            },
            { method: "DELETE", url: "https://api.github.com/installation/token", body: undefined },
            { method: "DELETE", url: "https://api.github.com/installation/token", body: undefined },
          ],
        )
        assert.strictEqual(requests[1]?.authorization, `Bearer ${secret}`)
        assert.strictEqual(failure._tag, "GitHubAppAuthError")
        assert.notInclude(Cause.pretty(Cause.fail(failure)), secret)
        for (const line of logs) assert.notInclude(line, secret)
      }),
  )
})
