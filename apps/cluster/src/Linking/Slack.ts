import * as DateTime from "effect/DateTime"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as UrlParams from "effect/unstable/http/UrlParams"
import * as Jwks from "../Ingress/Jwks.ts"
import { LinkProofFailed, type ProvenAccount } from "./Proof.ts"

/**
 * Slack workspace/user ownership through Sign in with Slack (OpenID Connect).
 * The browser proves nothing: the authorization code is exchanged here, and
 * the ID token's signature, issuer, audience, expiry, nonce and workspace are
 * checked before the account counts as proven (spec: "Identity").
 */

export const SLACK_AUTHORIZE_URL = "https://slack.com/openid/connect/authorize"
export const SLACK_TOKEN_URL = "https://slack.com/api/openid.connect.token"
export const SLACK_KEYS_URL = "https://slack.com/openid/connect/keys"
const SLACK_ISSUER = "https://slack.com"
/** `openid` is required; `profile` adds the display name. */
const SLACK_SCOPES = "openid profile"

export interface SlackLinkConfig {
  readonly clientId: string
  readonly clientSecret: Redacted.Redacted<string>
  /** Must match a redirect URL registered on the Slack app. */
  readonly redirectUri: string
  /** Workspaces whose members may link; others are rejected after proof. */
  readonly workspaceIds: ReadonlyArray<string>
  readonly keyCacheTtl?: Duration.Duration
  readonly refreshCooldown?: Duration.Duration
}

export interface SlackLink {
  readonly authorizeUrl: (state: string, nonce: string) => string
  readonly prove: (code: string, nonce: string) => Effect.Effect<ProvenAccount, LinkProofFailed>
}

const TokenResponse = Schema.Struct({
  body: Schema.Struct({
    ok: Schema.Boolean,
    error: Schema.optionalKey(Schema.String),
    id_token: Schema.optionalKey(Schema.String),
  }),
})

const IdTokenClaims = Schema.Struct({
  iss: Schema.String,
  aud: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  exp: Schema.Finite,
  nonce: Schema.optionalKey(Schema.String),
  "https://slack.com/team_id": Schema.NonEmptyString,
  "https://slack.com/user_id": Schema.NonEmptyString,
  name: Schema.optionalKey(Schema.String),
})

const decodeClaims = Schema.decodeUnknownEffect(IdTokenClaims)

const failed =
  (reason: LinkProofFailed["reason"], message: string) =>
  (cause?: unknown): LinkProofFailed =>
    new LinkProofFailed({ platform: "slack", reason, message, cause })

const rejected = failed("token-rejected", "Slack returned an ID token Janitor cannot accept.")

export const make = Effect.fnUntraced(function* (config: SlackLinkConfig) {
  const http = yield* HttpClient.HttpClient
  const keys = yield* Jwks.makeKeySet({
    url: SLACK_KEYS_URL,
    ...(config.keyCacheTtl === undefined ? {} : { keyCacheTtl: config.keyCacheTtl }),
    ...(config.refreshCooldown === undefined ? {} : { refreshCooldown: config.refreshCooldown }),
  })
  const decodeToken = HttpClientResponse.schemaJson(TokenResponse)

  const authorizeUrl = (state: string, nonce: string) => {
    const url = new URL(SLACK_AUTHORIZE_URL)
    url.searchParams.set("response_type", "code")
    url.searchParams.set("scope", SLACK_SCOPES)
    url.searchParams.set("client_id", config.clientId)
    url.searchParams.set("redirect_uri", config.redirectUri)
    url.searchParams.set("state", state)
    url.searchParams.set("nonce", nonce)
    // One configured workspace can be preselected; more than one leaves the choice to Slack.
    if (config.workspaceIds.length === 1) url.searchParams.set("team", config.workspaceIds[0]!)
    return url.toString()
  }

  const exchange = (code: string) =>
    http
      .execute(
        HttpClientRequest.post(SLACK_TOKEN_URL).pipe(
          HttpClientRequest.bodyUrlParams(
            UrlParams.fromInput({
              grant_type: "authorization_code",
              client_id: config.clientId,
              client_secret: Redacted.value(config.clientSecret),
              code,
              redirect_uri: config.redirectUri,
            }),
          ),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(decodeToken),
        Effect.mapError(failed("exchange-failed", "Slack did not accept the sign-in. Try again.")),
        Effect.flatMap((response) =>
          response.body.ok && response.body.id_token !== undefined
            ? Effect.succeed(response.body.id_token)
            : Effect.fail(
                failed(
                  "exchange-failed",
                  "Slack did not accept the sign-in. Try again.",
                )(response.body.error),
              ),
        ),
      )

  const verify = (idToken: string, nonce: string) =>
    Effect.gen(function* () {
      const token = yield* Jwks.parseCompact(idToken).pipe(Effect.mapError(rejected))
      if (token.header.alg !== "RS256") return yield* rejected("unsupported algorithm")
      const claims = yield* decodeClaims(token.claims).pipe(Effect.mapError(rejected))
      if (claims.iss !== SLACK_ISSUER) return yield* rejected("unknown issuer")
      const key = yield* keys.keyFor(token.header.kid).pipe(Effect.mapError(rejected))
      if (!(yield* Jwks.verifyRs256(key, token.signingInput, token.signature))) {
        return yield* rejected("invalid signature")
      }
      const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud
      if (!audiences.includes(config.clientId)) return yield* rejected("wrong audience")
      const nowSeconds = Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1000)
      if (claims.exp <= nowSeconds) return yield* rejected("expired")
      // The nonce binds this token to the attempt the browser started.
      if (claims.nonce !== nonce) {
        return yield* failed(
          "nonce-mismatch",
          "This Slack sign-in does not belong to the attempt you started. Start again.",
        )()
      }
      const workspaceId = claims["https://slack.com/team_id"]
      if (!config.workspaceIds.includes(workspaceId)) {
        return yield* failed(
          "wrong-workspace",
          "That Slack workspace is not connected to this Janitor.",
        )(workspaceId)
      }
      const accountId = claims["https://slack.com/user_id"]
      const account: ProvenAccount = {
        workspaceId,
        accountId,
        displayName: claims.name ?? accountId,
      }
      return account
    })

  const prove = (code: string, nonce: string) =>
    exchange(code).pipe(Effect.flatMap((idToken) => verify(idToken, nonce)))

  const link: SlackLink = { authorizeUrl, prove }
  return link
})
