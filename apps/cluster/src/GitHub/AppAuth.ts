import {
  GITHUB_API_BASE_URL,
  GITHUB_API_VERSION,
  GITHUB_USER_AGENT,
  GitHubInstallationAccessToken,
} from "@janitor/domain/GitHub/Api"
import type { GitHubInstallationId } from "@janitor/domain/GitHub/Id"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"

export class GitHubAppAuthError extends Data.TaggedError("GitHubAppAuthError")<{
  readonly operation: "importKey" | "signJwt" | "installationToken"
  readonly message: string
  readonly cause?: unknown
}> {}

export interface GitHubAppCredentials {
  readonly appId: string
  /** PEM, either PKCS#8 ("BEGIN PRIVATE KEY") or the PKCS#1 form GitHub downloads. */
  readonly privateKey: Redacted.Redacted<string>
}

export const config = (paths: {
  readonly appId: string
  readonly privateKey: string
}): Config.Wrap<GitHubAppCredentials> => ({
  appId: Config.schema(Schema.NonEmptyString, paths.appId),
  privateKey: Config.schema(Schema.RedactedFromValue(Schema.NonEmptyString), paths.privateKey),
})

/** Issues the App JWT and exchanges it for cached installation tokens. */
export class GitHubAppAuth extends Context.Service<
  GitHubAppAuth,
  {
    readonly appJwt: Effect.Effect<Redacted.Redacted<string>, GitHubAppAuthError>
    readonly installationToken: (
      installationId: GitHubInstallationId,
    ) => Effect.Effect<Redacted.Redacted<string>, GitHubAppAuthError>
    /** Drops a cached token after GitHub rejected it. */
    readonly invalidateInstallationToken: (
      installationId: GitHubInstallationId,
    ) => Effect.Effect<void>
  }
>()("@janitor/cluster/GitHub/AppAuth/GitHubAppAuth") {}

const JWT_LIFETIME = Duration.minutes(9)
const JWT_CLOCK_SKEW = Duration.seconds(60)
const TOKEN_REFRESH_MARGIN = Duration.minutes(2)

// DER: SEQUENCE { INTEGER 0, AlgorithmIdentifier rsaEncryption, OCTET STRING pkcs1 }
const RSA_ALGORITHM_IDENTIFIER = Uint8Array.from([
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
])
const INTEGER_ZERO = Uint8Array.from([0x02, 0x01, 0x00])

const derLength = (length: number): Uint8Array => {
  if (length < 0x80) return Uint8Array.from([length])
  const bytes: Array<number> = []
  let remaining = length
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff)
    remaining >>= 8
  }
  return Uint8Array.from([0x80 | bytes.length, ...bytes])
}

const derTag = (tag: number, content: Uint8Array): Uint8Array => {
  const length = derLength(content.byteLength)
  const out = new Uint8Array(1 + length.byteLength + content.byteLength)
  out[0] = tag
  out.set(length, 1)
  out.set(content, 1 + length.byteLength)
  return out
}

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

/** Wraps an RSA PKCS#1 private key in the PKCS#8 envelope WebCrypto requires. */
export const pkcs1ToPkcs8 = (pkcs1: Uint8Array): Uint8Array =>
  derTag(0x30, concat(INTEGER_ZERO, RSA_ALGORITHM_IDENTIFIER, derTag(0x04, pkcs1)))

const PEM_PATTERN = /-----BEGIN ([A-Z ]+)-----([\s\S]+?)-----END \1-----/

/** Returns PKCS#8 DER bytes for either PEM form GitHub Apps use. */
export const privateKeyDer = (pem: string): Effect.Effect<Uint8Array, GitHubAppAuthError> =>
  Effect.gen(function* () {
    // Accept a key pasted as one line with literal "\n" sequences, as env
    // files and secret managers often store it.
    const match = PEM_PATTERN.exec(pem.replace(/\\n/g, "\n"))
    if (match === null) {
      return yield* new GitHubAppAuthError({
        operation: "importKey",
        message: "Private key is not PEM encoded",
      })
    }
    const label = match[1]
    const body = (match[2] ?? "").replace(/\s+/g, "")
    const der = yield* Effect.fromResult(Encoding.decodeBase64(body)).pipe(
      Effect.mapError(
        () =>
          new GitHubAppAuthError({ operation: "importKey", message: "Private key is not base64" }),
      ),
    )
    switch (label) {
      case "PRIVATE KEY":
        return der
      case "RSA PRIVATE KEY":
        return pkcs1ToPkcs8(der)
      default:
        return yield* new GitHubAppAuthError({
          operation: "importKey",
          message: `Unsupported private key type: ${label}`,
        })
    }
  })

const base64UrlJson = (value: unknown): string =>
  Encoding.encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)))

export const make = Effect.fnUntraced(function* (credentials: GitHubAppCredentials) {
  const http = yield* HttpClient.HttpClient
  const decodeToken = HttpClientResponse.schemaJson(
    Schema.Struct({ body: GitHubInstallationAccessToken }),
  )

  const der = yield* privateKeyDer(Redacted.value(credentials.privateKey))
  const signingKey = yield* Effect.tryPromise({
    try: () =>
      crypto.subtle.importKey(
        "pkcs8",
        new Uint8Array(der),
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"],
      ),
    catch: (cause) =>
      new GitHubAppAuthError({
        operation: "importKey",
        message: "WebCrypto rejected the private key",
        cause,
      }),
  })

  const signJwt = Effect.fn("GitHubAppAuth.signJwt")(function* () {
    const now = yield* DateTime.now
    const issuedAt = DateTime.subtractDuration(now, JWT_CLOCK_SKEW)
    const expiresAt = DateTime.addDuration(now, JWT_LIFETIME)
    const header = base64UrlJson({ alg: "RS256", typ: "JWT" })
    const payload = base64UrlJson({
      iat: Math.floor(DateTime.toEpochMillis(issuedAt) / 1000),
      exp: Math.floor(DateTime.toEpochMillis(expiresAt) / 1000),
      iss: credentials.appId,
    })
    const signingInput = `${header}.${payload}`
    const signature = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.sign("RSASSA-PKCS1-v1_5", signingKey, new TextEncoder().encode(signingInput)),
      catch: (cause) =>
        new GitHubAppAuthError({ operation: "signJwt", message: "JWT signing failed", cause }),
    })
    return {
      jwt: Redacted.make(`${signingInput}.${Encoding.encodeBase64Url(new Uint8Array(signature))}`),
      expiresAt,
    }
  })

  // One JWT serves many requests until it nears expiry.
  let cachedJwt: Option.Option<{ jwt: Redacted.Redacted<string>; expiresAt: DateTime.Utc }> =
    Option.none()
  const appJwt = Effect.gen(function* () {
    const now = yield* DateTime.now
    if (
      Option.isSome(cachedJwt) &&
      DateTime.isGreaterThan(cachedJwt.value.expiresAt, DateTime.addDuration(now, JWT_CLOCK_SKEW))
    ) {
      return cachedJwt.value.jwt
    }
    const fresh = yield* signJwt()
    cachedJwt = Option.some(fresh)
    return fresh.jwt
  })

  const tokens = new Map<GitHubInstallationId, GitHubInstallationAccessToken>()

  const installationToken = Effect.fn("GitHubAppAuth.installationToken")(function* (
    installationId: GitHubInstallationId,
  ) {
    const now = yield* DateTime.now
    const cached = tokens.get(installationId)
    if (
      cached !== undefined &&
      DateTime.isGreaterThan(cached.expiresAt, DateTime.addDuration(now, TOKEN_REFRESH_MARGIN))
    ) {
      return cached.token
    }
    const jwt = yield* appJwt
    const request = HttpClientRequest.post(
      `${GITHUB_API_BASE_URL}/app/installations/${installationId}/access_tokens`,
    ).pipe(
      HttpClientRequest.bearerToken(Redacted.value(jwt)),
      HttpClientRequest.setHeaders({
        accept: "application/vnd.github+json",
        "x-github-api-version": GITHUB_API_VERSION,
        "user-agent": GITHUB_USER_AGENT,
      }),
    )
    const response = yield* http.execute(request).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(decodeToken),
      Effect.mapError(
        (cause) =>
          new GitHubAppAuthError({
            operation: "installationToken",
            message: `Installation token request failed for ${installationId}`,
            cause,
          }),
      ),
    )
    tokens.set(installationId, response.body)
    return response.body.token
  })

  const invalidateInstallationToken = (installationId: GitHubInstallationId) =>
    Effect.sync(() => {
      tokens.delete(installationId)
    })

  return { appJwt, installationToken, invalidateInstallationToken }
})

/** Builds the auth service from already resolved credentials. */
export const layerFrom = (
  credentials: GitHubAppCredentials,
): Layer.Layer<GitHubAppAuth, never, HttpClient.HttpClient> =>
  // An unusable private key is a deployment defect, not a runtime condition.
  Layer.effect(GitHubAppAuth, make(credentials).pipe(Effect.orDie))

export const layer = (
  config: Config.Wrap<GitHubAppCredentials>,
): Layer.Layer<GitHubAppAuth, Config.ConfigError, HttpClient.HttpClient> =>
  Layer.unwrap(Effect.map(Config.unwrap(config), layerFrom))
