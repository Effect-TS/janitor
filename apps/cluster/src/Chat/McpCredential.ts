import {
  type McpServerConfig,
  McpOAuthRefused,
  McpOAuthUnavailable,
  type McpServerStatus,
} from "@janitor/domain/Chat/McpServer"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/http/HttpClientResponse"

/**
 * An MCP server's credential (EFF-3443), one per server configured on the
 * dashboard, kept in that server's own Durable Object
 * (`McpCredentialObject.ts`). It holds either a bearer token set on the
 * dashboard, or what **Connect** got from the server's OAuth authorisation
 * server: the registered client and a refresh token, which it swaps for
 * short-lived access tokens ahead of expiry, one refresh at a time, storing
 * a rotated refresh token before handing out the access token.
 *
 * No token, client secret, PKCE verifier or code is ever logged or put in an
 * error.
 */

/** No access token now: none set, consent needed, or a refresh failed. */
export class McpUnavailable extends Schema.TaggedError<McpUnavailable>()("McpUnavailable", {}) {}

export interface McpCredential {
  /**
   * The token to send. An OAuth access token has more than five minutes
   * left; `rejected` is a token the server answered 401 to, which is
   * replaced if it's still the current one.
   */
  readonly token: (
    rejected?: Redacted.Redacted<string>,
  ) => Effect.Effect<Redacted.Redacted<string>, McpUnavailable>
  readonly status: Effect.Effect<McpServerStatus>
  /** Replaces whatever the credential held with a bearer token. */
  readonly setBearer: (token: Redacted.Redacted<string>) => Effect.Effect<void>
  /**
   * **Connect**'s start: discovers the authorisation server, registers a
   * client for `redirectUri` and answers the URL to send the browser to.
   */
  readonly startOAuth: (input: {
    readonly redirectUri: string
  }) => Effect.Effect<string, McpOAuthUnavailable>
  /** **Connect**'s callback: exchanges the code for tokens, once, within 10 minutes of the start. */
  readonly finishOAuth: (input: {
    readonly code: string
    readonly state: string
  }) => Effect.Effect<void, McpOAuthRefused>
  /** Forgets everything, storage included. */
  readonly wipe: Effect.Effect<void>
}

export interface McpCredentialOptions {
  /** The MCP server's URL: where discovery starts, and the `resource` tokens are for. */
  readonly url: string
  /** Where the credential survives a restart. */
  readonly storage: {
    readonly load: Effect.Effect<unknown, unknown>
    readonly save: (value: unknown) => Effect.Effect<void, unknown>
    readonly clear: Effect.Effect<void, unknown>
  }
}

/** Each configured server's credential, for turns and the dashboard. */
export class McpCredentials extends Context.Service<
  McpCredentials,
  { readonly forServer: (server: McpServerConfig) => Effect.Effect<McpCredential> }
>()("@janitor/cluster/Chat/McpCredential/McpCredentials") {}

/**
 * A token is reused only while more than this is left of it. With hour-long
 * tokens that's a refresh every 55 minutes. A token that lives this long or
 * less, which is what an answer without `expires_in` is taken to, is
 * refreshed on every call: one refresh, and one rotation, per MCP request.
 */
const REFRESH_WINDOW = Duration.minutes(5)
/** How long a token without `expires_in` is taken to live. */
const DEFAULT_LIFETIME = Duration.minutes(5)
const REQUEST_TIMEOUT = Duration.seconds(15)
/** After a failed refresh, how long calls fail without asking again. */
const BACKOFF = Duration.seconds(30)
/** How long a **Connect** may take between its start and its callback. */
const CONSENT_WINDOW = Duration.minutes(10)

const AuthMethod = Schema.Literals(["none", "client_secret_post", "client_secret_basic"])

/** A client registered with the authorisation server. */
const OAuthClient = Schema.Struct({
  clientId: Schema.String,
  clientSecret: Schema.optional(Schema.String),
  authMethod: AuthMethod,
  tokenUrl: Schema.String,
})
type OAuthClient = typeof OAuthClient.Type

/** What storage holds: one of a bearer token or OAuth, and a **Connect** under way. */
const Stored = Schema.Struct({
  bearer: Schema.optional(Schema.String),
  oauth: Schema.optional(
    Schema.Struct({
      client: OAuthClient,
      /** Null when the authorisation server gave none: the access token can't be renewed. */
      refreshToken: Schema.NullOr(Schema.String),
      needsConsent: Schema.Boolean,
    }),
  ),
  pending: Schema.optional(
    Schema.Struct({
      state: Schema.String,
      verifier: Schema.String,
      redirectUri: Schema.String,
      startedAt: Schema.Finite,
      client: OAuthClient,
    }),
  ),
})
type Stored = typeof Stored.Type

const decodeStored = Schema.decodeUnknownEffect(Stored)

const TokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  expires_in: Schema.optional(Schema.Finite),
  refresh_token: Schema.optional(Schema.NonEmptyString),
})
type TokenResponse = typeof TokenResponse.Type
const decodeTokenResponse = Schema.decodeUnknownEffect(TokenResponse)

const ErrorResponse = Schema.Struct({ error: Schema.String })
const decodeErrorResponse = Schema.decodeUnknownEffect(ErrorResponse)

const ResourceMetadata = Schema.Struct({
  authorization_servers: Schema.optional(Schema.Array(Schema.String)),
  scopes_supported: Schema.optional(Schema.Array(Schema.String)),
})
const decodeResourceMetadata = Schema.decodeUnknownEffect(ResourceMetadata)

const ServerMetadata = Schema.Struct({
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  registration_endpoint: Schema.optional(Schema.String),
  code_challenge_methods_supported: Schema.optional(Schema.Array(Schema.String)),
})
const decodeServerMetadata = Schema.decodeUnknownEffect(ServerMetadata)

const Registration = Schema.Struct({
  client_id: Schema.String,
  client_secret: Schema.optional(Schema.String),
  token_endpoint_auth_method: Schema.optional(Schema.String),
})
const decodeRegistration = Schema.decodeUnknownEffect(Registration)

/** The OAuth errors that mean the refresh token or the client is gone for good. */
const CONSENT_ERRORS = new Set(["invalid_grant", "invalid_client"])

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")

const randomToken = () => base64url(crypto.getRandomValues(new Uint8Array(32)))

const challengeFor = (verifier: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).pipe(
    Effect.map((digest) => base64url(new Uint8Array(digest))),
  )

/** RFC 8414 and RFC 9728's well-known URL: the suffix goes between the host and the path. */
const wellKnown = (base: string, suffix: string) => {
  const url = new URL(base)
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "")
  return `${url.origin}/.well-known/${suffix}${path}`
}

interface Cached {
  readonly token: string
  readonly expiresAt: number
}

/** Why a refresh failed: for the log, never with content. */
type Failure =
  | { readonly _tag: "Consent"; readonly error: string }
  | { readonly _tag: "Transient"; readonly reason: string }

const transient = (reason: string): Failure => ({ _tag: "Transient", reason })

const empty: Stored = {}

/** A failure's category, for the log: never its content. */
const describe = (reason: unknown): string =>
  typeof reason === "string"
    ? reason
    : typeof reason === "object" && reason !== null && "_tag" in reason
      ? String(reason._tag)
      : "unknown"

export const makeMcpCredential = (
  options: McpCredentialOptions,
): Effect.Effect<McpCredential, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient

    /** What storage holds, once read. */
    let state: Stored | undefined
    let cached: Cached | undefined
    let failedAt: number | undefined
    let inflight: Deferred.Deferred<Redacted.Redacted<string>, McpUnavailable> | undefined

    /** Storage's state; empty when storage is empty or unreadable. */
    const load = Effect.suspend(() =>
      state !== undefined
        ? Effect.succeed(state)
        : options.storage.load.pipe(
            Effect.flatMap((value) =>
              value === undefined ? Effect.succeed(empty) : decodeStored(value),
            ),
            Effect.orElseSucceed(() => empty),
            Effect.map((stored) => {
              state ??= stored
              return state
            }),
          ),
    )

    /** Stores `next`, and keeps it in memory even when the write fails. */
    const save = (next: Stored) =>
      Effect.suspend(() => {
        state = next
        return options.storage.save(next)
      })

    /** A JSON GET or POST, answered only when it succeeds. */
    const fetchJson = (request: HttpClientRequest.HttpClientRequest) =>
      HttpClient.filterStatusOk(http)
        .execute(HttpClientRequest.acceptJson(request))
        .pipe(
          Effect.flatMap((response) => response.json),
          Effect.scoped,
          Effect.timeout(REQUEST_TIMEOUT),
        )

    /** A form-encoded request to the token endpoint, authenticated as `client`. */
    const tokenRequest = (client: OAuthClient, params: Record<string, string>) => {
      const secret = client.clientSecret
      const basic = client.authMethod === "client_secret_basic" && secret !== undefined
      const request = HttpClientRequest.post(client.tokenUrl).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.bodyUrlParams({
          ...params,
          ...(basic ? {} : { client_id: client.clientId }),
          ...(client.authMethod === "client_secret_post" && secret !== undefined
            ? { client_secret: secret }
            : {}),
        }),
      )
      return basic
        ? HttpClientRequest.basicAuth(
            request,
            encodeURIComponent(client.clientId),
            encodeURIComponent(secret),
          )
        : request
    }

    /** The token endpoint's answer: tokens, or why not. */
    const tokens = (response: HttpClientResponse.HttpClientResponse) =>
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
                body._tag === "Some" && CONSENT_ERRORS.has(body.value.error)
                  ? { _tag: "Consent", error: body.value.error }
                  : transient(`status ${response.status}`),
              ),
            ),
          )

    /** Sends a token request, within the timeout. */
    const grant = (client: OAuthClient, params: Record<string, string>) =>
      http.execute(tokenRequest(client, params)).pipe(
        Effect.flatMap(tokens),
        Effect.scoped,
        Effect.timeoutOrElse({
          duration: REQUEST_TIMEOUT,
          orElse: () => Effect.fail(transient("timeout")),
        }),
        Effect.catchTag("HttpClientError", () => Effect.fail(transient("network"))),
      )

    /** Keeps the access token in memory only. */
    const cache = (granted: TokenResponse) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        const lifetime =
          granted.expires_in === undefined
            ? Duration.toMillis(DEFAULT_LIFETIME)
            : granted.expires_in * 1000
        cached = { token: granted.access_token, expiresAt: now + lifetime }
        failedAt = undefined
        return Redacted.make(granted.access_token)
      })

    /** Refreshes the access token, storing a rotated refresh token before handing it out. */
    const refresh: Effect.Effect<Redacted.Redacted<string>, McpUnavailable> = Effect.gen(
      function* () {
        const current = yield* load
        const oauth = current.oauth
        if (oauth === undefined || oauth.needsConsent) return yield* new McpUnavailable()
        if (oauth.refreshToken === null)
          return yield* Effect.fail<Failure>({ _tag: "Consent", error: "no_refresh_token" })
        const granted = yield* grant(oauth.client, {
          grant_type: "refresh_token",
          refresh_token: oauth.refreshToken,
          resource: options.url,
        })
        if (granted.refresh_token !== undefined && granted.refresh_token !== oauth.refreshToken)
          yield* save({
            ...current,
            oauth: { ...oauth, refreshToken: granted.refresh_token },
          }).pipe(Effect.mapError(() => transient("storage")))
        return yield* cache(granted)
      },
    ).pipe(
      Effect.catchIf(
        (error): error is Failure => error._tag !== "McpUnavailable",
        (failure) =>
          Effect.gen(function* () {
            cached = undefined
            if (failure._tag === "Consent") {
              yield* Effect.logError(
                "An MCP server's authorisation server refused the refresh token; Connect it again",
              ).pipe(Effect.annotateLogs({ error: failure.error }))
              const current = yield* load
              if (current.oauth !== undefined)
                yield* save({ ...current, oauth: { ...current.oauth, needsConsent: true } }).pipe(
                  Effect.ignore,
                )
            } else {
              failedAt = yield* Clock.currentTimeMillis
              yield* Effect.logWarning("Couldn't refresh an MCP server's access token").pipe(
                Effect.annotateLogs({ reason: failure.reason }),
              )
            }
            return yield* new McpUnavailable()
          }),
      ),
    )

    /** Read through a function, so a check after a wait isn't narrowed away. */
    const running = () => inflight

    const token = (
      rejected?: Redacted.Redacted<string>,
    ): Effect.Effect<Redacted.Redacted<string>, McpUnavailable> =>
      Effect.gen(function* () {
        if (inflight !== undefined) return yield* Deferred.await(inflight)
        const current = yield* load
        if (current.bearer !== undefined) return Redacted.make(current.bearer)
        if (current.oauth === undefined || current.oauth.needsConsent)
          return yield* new McpUnavailable()
        // Another caller may have started a refresh while storage was read.
        const started = running()
        if (started !== undefined) return yield* Deferred.await(started)
        const now = yield* Clock.currentTimeMillis
        if (
          cached !== undefined &&
          cached.expiresAt - now > Duration.toMillis(REFRESH_WINDOW) &&
          (rejected === undefined || Redacted.value(rejected) !== cached.token)
        )
          return Redacted.make(cached.token)
        if (failedAt !== undefined && now - failedAt < Duration.toMillis(BACKOFF))
          return yield* new McpUnavailable()

        // The refresh runs on its own fiber, so a caller giving up never
        // leaves the others waiting or a rotated refresh token unstored.
        const done = Deferred.makeUnsafe<Redacted.Redacted<string>, McpUnavailable>()
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

    const status = Effect.map(load, (current): McpServerStatus => {
      if (current.bearer !== undefined) return "connected"
      if (current.oauth === undefined) return "no-credential"
      if (current.oauth.needsConsent) return "needs-consent"
      return failedAt === undefined ? "connected" : "unavailable"
    })

    const setBearer = (bearer: Redacted.Redacted<string>) =>
      Effect.gen(function* () {
        cached = undefined
        failedAt = undefined
        yield* save({ bearer: Redacted.value(bearer) }).pipe(Effect.orDie)
      })

    const startOAuth = ({ redirectUri }: { readonly redirectUri: string }) =>
      Effect.gen(function* () {
        // RFC 9728: the MCP server names its authorisation server. Without
        // that metadata, its own origin is taken to be one.
        const resource = yield* fetchJson(
          HttpClientRequest.get(wellKnown(options.url, "oauth-protected-resource")),
        ).pipe(
          Effect.catch(() =>
            fetchJson(
              HttpClientRequest.get(
                wellKnown(new URL(options.url).origin, "oauth-protected-resource"),
              ),
            ),
          ),
          Effect.flatMap(decodeResourceMetadata),
          Effect.orElseSucceed(() => ResourceMetadata.make({})),
        )
        const issuer = resource.authorization_servers?.[0] ?? new URL(options.url).origin
        const metadata = yield* fetchJson(
          HttpClientRequest.get(wellKnown(issuer, "oauth-authorization-server")),
        ).pipe(
          Effect.catch(() =>
            fetchJson(HttpClientRequest.get(wellKnown(issuer, "openid-configuration"))),
          ),
          Effect.flatMap(decodeServerMetadata),
        )
        if (
          metadata.registration_endpoint === undefined ||
          (metadata.code_challenge_methods_supported !== undefined &&
            !metadata.code_challenge_methods_supported.includes("S256"))
        )
          return yield* Effect.fail("unsupported" as const)
        const scope = resource.scopes_supported?.join(" ")

        const registered = yield* fetchJson(
          HttpClientRequest.post(metadata.registration_endpoint).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              client_name: "janitor",
              redirect_uris: [redirectUri],
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
              token_endpoint_auth_method: "none",
              ...(scope === undefined ? {} : { scope }),
            }),
          ),
        ).pipe(Effect.flatMap(decodeRegistration))
        const authMethod = Schema.is(AuthMethod)(registered.token_endpoint_auth_method)
          ? registered.token_endpoint_auth_method
          : registered.client_secret === undefined
            ? "none"
            : "client_secret_post"
        const client: OAuthClient = {
          clientId: registered.client_id,
          ...(registered.client_secret === undefined
            ? {}
            : { clientSecret: registered.client_secret }),
          authMethod,
          tokenUrl: metadata.token_endpoint,
        }

        const verifier = randomToken()
        const state = randomToken()
        const startedAt = yield* Clock.currentTimeMillis
        const current = yield* load
        yield* save({ ...current, pending: { state, verifier, redirectUri, startedAt, client } })

        const url = new URL(metadata.authorization_endpoint)
        url.searchParams.set("response_type", "code")
        url.searchParams.set("client_id", client.clientId)
        url.searchParams.set("redirect_uri", redirectUri)
        url.searchParams.set("code_challenge", yield* challengeFor(verifier))
        url.searchParams.set("code_challenge_method", "S256")
        url.searchParams.set("state", state)
        url.searchParams.set("resource", options.url)
        if (scope !== undefined) url.searchParams.set("scope", scope)
        return url.href
      }).pipe(
        Effect.catch(() =>
          Effect.logWarning("Couldn't start an MCP server's Connect").pipe(
            Effect.andThen(Effect.fail(new McpOAuthUnavailable())),
          ),
        ),
      )

    const finishOAuth = ({
      code,
      state: given,
    }: {
      readonly code: string
      readonly state: string
    }) =>
      Effect.gen(function* () {
        const current = yield* load
        const pending = current.pending
        const now = yield* Clock.currentTimeMillis
        if (
          pending === undefined ||
          pending.state !== given ||
          now - pending.startedAt > Duration.toMillis(CONSENT_WINDOW)
        )
          return yield* Effect.fail("state" as const)
        // Used up before the exchange, so a replayed callback can't try twice.
        const { pending: _, ...rest } = current
        yield* save(rest)
        const granted = yield* grant(pending.client, {
          grant_type: "authorization_code",
          code,
          redirect_uri: pending.redirectUri,
          code_verifier: pending.verifier,
          resource: options.url,
        })
        yield* save({
          oauth: {
            client: pending.client,
            refreshToken: granted.refresh_token ?? null,
            needsConsent: false,
          },
        })
        yield* cache(granted)
      }).pipe(
        Effect.catch((reason) =>
          Effect.logWarning("Refused an MCP server's Connect callback").pipe(
            Effect.annotateLogs({ reason: describe(reason) }),
            Effect.andThen(Effect.fail(new McpOAuthRefused())),
          ),
        ),
      )

    const wipe = Effect.gen(function* () {
      state = empty
      cached = undefined
      failedAt = undefined
      yield* options.storage.clear.pipe(Effect.orDie)
    })

    return { token, status, setBearer, startOAuth, finishOAuth, wipe }
  })
