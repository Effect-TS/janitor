import {
  type McpServerConfig,
  McpOAuthRefused,
  McpOAuthUnavailable,
  type McpServerStatus,
} from "@janitor/domain/Chat/McpServer"
import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js"
import {
  InvalidClientError,
  InvalidGrantError,
  OAuthError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js"
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/http/HttpClient"
import { fetchVia } from "./McpFetch.ts"

/**
 * An MCP server's credential (EFF-3443), one per server configured on the
 * dashboard, kept in that server's own Durable Object
 * (`McpCredentialObject.ts`). It holds either a bearer token set on the
 * dashboard, or what **Connect** got from the server's OAuth authorisation
 * server: the registered client and a refresh token, which it swaps for
 * short-lived access tokens ahead of expiry, one refresh at a time, storing
 * a rotated refresh token before handing out the access token. The OAuth
 * protocol itself (discovery, registration, PKCE, client authentication and
 * token requests) is the MCP SDK's; this keeps only what is janitor's.
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

/** JSON the MCP SDK produced and reads back: its client registration and server metadata. */
const Json = Schema.Record(Schema.String, Schema.Unknown)

/** A client registered with an authorisation server, as the SDK's helpers take it. */
const OAuthClient = Schema.Struct({
  /** The authorisation server's URL. */
  server: Schema.String,
  /** Its metadata, when discovery found it. */
  metadata: Schema.optional(Json),
  /** The registration the server answered, client secret included. */
  information: Json,
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

/** The SDK's view of a stored client. */
const sdkClient = (client: OAuthClient) => ({
  ...(client.metadata === undefined
    ? {}
    : { metadata: client.metadata as AuthorizationServerMetadata }),
  clientInformation: client.information as OAuthClientInformationMixed,
})

/** An absolute `https:` URL. */
const isHttps = (url: string) => URL.canParse(url) && new URL(url).protocol === "https:"

const randomState = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")

interface Cached {
  readonly token: string
  readonly expiresAt: number
}

/** Why a refresh failed: for the log, never with content. */
type Failure =
  | { readonly _tag: "Consent"; readonly error: string }
  | { readonly _tag: "Transient"; readonly reason: string }

/**
 * What the SDK's error says, by category only: an OAuth error code, the
 * error's name, or a timeout. Its message can echo a response body, so it's
 * never kept.
 */
const failureOf = (error: unknown): Failure =>
  error instanceof InvalidGrantError || error instanceof InvalidClientError
    ? { _tag: "Consent", error: error.errorCode }
    : {
        _tag: "Transient",
        reason:
          error === "timeout"
            ? "timeout"
            : error instanceof OAuthError
              ? error.errorCode
              : error instanceof Error
                ? error.name
                : "unknown",
      }

const empty: Stored = {}

/** A failure's category, for the log: never its content. */
const describe = (reason: unknown): string =>
  typeof reason === "object" && reason !== null && "_tag" in reason
    ? reason._tag === "Consent" && "error" in reason
      ? String(reason.error)
      : "reason" in reason
        ? String(reason.reason)
        : String(reason._tag)
    : typeof reason === "string"
      ? reason
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
    /**
     * Counts the changes that replace the credential: a wipe, a bearer token
     * and a successful Connect. A refresh that started under an older count
     * keeps none of its results, so it can't bring back a wiped credential or
     * overwrite a newer one.
     */
    let generation = 0
    /** Starts a new generation: the refresh in flight, if any, is left to finish unheard. */
    const replaced = () => {
      generation += 1
      inflight = undefined
      cached = undefined
      failedAt = undefined
    }

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

    const fetchFn = fetchVia(http, yield* Effect.context<never>())

    /** One SDK call over `http`, within the timeout; its failures by category. */
    const sdk = <A>(call: (fetch: typeof fetchFn) => Promise<A>) =>
      Effect.tryPromise({ try: () => call(fetchFn), catch: failureOf }).pipe(
        Effect.timeoutOrElse({
          duration: REQUEST_TIMEOUT,
          orElse: () => Effect.fail(failureOf("timeout")),
        }),
      )

    /** Keeps the access token in memory only. */
    const cache = (granted: OAuthTokens) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        const lifetime =
          granted.expires_in === undefined
            ? Duration.toMillis(DEFAULT_LIFETIME)
            : granted.expires_in * 1000
        cached = { token: granted.access_token, expiresAt: now + lifetime }
        failedAt = undefined
        return Redacted.make(granted.access_token)
      })

    /**
     * Refreshes the access token, storing a rotated refresh token before
     * handing it out, unless the credential was replaced meanwhile.
     */
    const refresh = (started: number): Effect.Effect<Redacted.Redacted<string>, McpUnavailable> =>
      Effect.gen(function* () {
        const current = yield* load
        const oauth = current.oauth
        if (oauth === undefined || oauth.needsConsent) return yield* new McpUnavailable()
        if (oauth.refreshToken === null)
          return yield* Effect.fail<Failure>({ _tag: "Consent", error: "no_refresh_token" })
        const refreshToken = oauth.refreshToken
        const granted = yield* sdk((fetchFn) =>
          refreshAuthorization(oauth.client.server, {
            ...sdkClient(oauth.client),
            refreshToken,
            resource: options.url,
            fetchFn,
          }),
        )
        if (started !== generation) return yield* new McpUnavailable()
        if (granted.refresh_token !== undefined && granted.refresh_token !== oauth.refreshToken) {
          // The latest state, so a Connect started meanwhile keeps its pending state.
          const latest = yield* load
          yield* save({
            ...latest,
            oauth: { ...oauth, refreshToken: granted.refresh_token },
          }).pipe(Effect.mapError((): Failure => ({ _tag: "Transient", reason: "storage" })))
        }
        return yield* cache(granted)
      }).pipe(
        Effect.catchIf(
          (error): error is Failure => error._tag !== "McpUnavailable",
          (failure) =>
            Effect.gen(function* () {
              if (started !== generation) return yield* new McpUnavailable()
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
        yield* refresh(generation).pipe(
          Effect.exit,
          Effect.flatMap((exit) =>
            Effect.suspend(() => {
              // A newer generation may have started its own refresh since.
              if (inflight === done) inflight = undefined
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
        replaced()
        yield* save({ bearer: Redacted.value(bearer) }).pipe(Effect.orDie)
      })

    const startOAuth = ({ redirectUri }: { readonly redirectUri: string }) =>
      Effect.gen(function* () {
        // The MCP server names its authorisation server (RFC 9728); without
        // that metadata, its own origin is taken to be one.
        const begun = generation
        const info = yield* sdk((fetchFn) => discoverOAuthServerInfo(options.url, { fetchFn }))
        const metadata = info.authorizationServerMetadata
        // Every endpoint the code, verifier and secrets go to is https,
        // checked before anything is sent to them: the registration, the
        // browser's authorisation URL and the token requests.
        const endpoints =
          metadata === undefined
            ? [info.authorizationServerUrl]
            : [
                info.authorizationServerUrl,
                metadata.authorization_endpoint,
                metadata.token_endpoint,
                metadata.registration_endpoint ?? info.authorizationServerUrl,
              ]
        if (!endpoints.every(isHttps)) return yield* Effect.fail("insecure endpoint" as const)
        const scope = info.resourceMetadata?.scopes_supported?.join(" ")
        const information = yield* sdk((fetchFn) =>
          registerClient(info.authorizationServerUrl, {
            ...(metadata === undefined ? {} : { metadata }),
            clientMetadata: {
              client_name: "janitor",
              redirect_uris: [redirectUri],
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
              token_endpoint_auth_method: "none",
            },
            ...(scope === undefined ? {} : { scope }),
            fetchFn,
          }),
        )
        const client: OAuthClient = {
          server: info.authorizationServerUrl,
          ...(metadata === undefined ? {} : { metadata: { ...metadata } }),
          information: { ...information },
        }
        const state = randomState()
        const { authorizationUrl, codeVerifier } = yield* sdk(() =>
          startAuthorization(client.server, {
            ...sdkClient(client),
            redirectUrl: redirectUri,
            state,
            resource: options.url,
            ...(scope === undefined ? {} : { scope }),
          }),
        )
        // A wipe meanwhile leaves no pending Connect behind in its storage.
        if (begun !== generation) return yield* Effect.fail("superseded" as const)
        const startedAt = yield* Clock.currentTimeMillis
        const current = yield* load
        yield* save({
          ...current,
          pending: { state, verifier: codeVerifier, redirectUri, startedAt, client },
        })
        return authorizationUrl.href
      }).pipe(
        Effect.catch((reason) =>
          Effect.logWarning("Couldn't start an MCP server's Connect").pipe(
            Effect.annotateLogs({ reason: describe(reason) }),
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
        // A wipe, a bearer token or another Connect during the exchange wins:
        // this callback then stores nothing, so it can't undo a deletion.
        const started = generation
        const granted = yield* sdk((fetchFn) =>
          exchangeAuthorization(pending.client.server, {
            ...sdkClient(pending.client),
            authorizationCode: code,
            codeVerifier: pending.verifier,
            redirectUri: pending.redirectUri,
            resource: options.url,
            fetchFn,
          }),
        )
        if (started !== generation) return yield* Effect.fail("superseded" as const)
        replaced()
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
      replaced()
      state = empty
      yield* options.storage.clear.pipe(Effect.orDie)
    })

    return { token, status, setBearer, startOAuth, finishOAuth, wipe }
  })
