import {
  GITHUB_API_BASE_URL,
  GITHUB_API_VERSION,
  GITHUB_USER_AGENT,
} from "@janitor/domain/GitHub/Api"
import { GitHubUserDatabaseIdFromNumber } from "@janitor/domain/GitHub/Id"
import { GITHUB_WORKSPACE_ID } from "@janitor/domain/Team/Account"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as UrlParams from "effect/unstable/http/UrlParams"
import { LinkProofFailed, type ProvenAccount } from "./Proof.ts"

/**
 * GitHub user ownership through the GitHub App's user authorization flow.
 * The code is exchanged for a user token that is used once, for the
 * authenticated user lookup, and never stored. The numeric user ID is the
 * identity; the login is display only (spec: "Identity").
 */

export const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize"
export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token"
export const GITHUB_USER_URL = `${GITHUB_API_BASE_URL}/user`

export interface GitHubLinkConfig {
  /** The GitHub App's OAuth client ID and secret. */
  readonly clientId: string
  readonly clientSecret: Redacted.Redacted<string>
  /** Must match a callback URL registered on the GitHub App. */
  readonly redirectUri: string
}

export interface GitHubLink {
  readonly authorizeUrl: (state: string) => string
  readonly prove: (code: string) => Effect.Effect<ProvenAccount, LinkProofFailed>
}

const TokenResponse = Schema.Struct({
  body: Schema.Struct({
    access_token: Schema.optionalKey(Schema.String),
    error: Schema.optionalKey(Schema.String),
  }),
})

const UserResponse = Schema.Struct({
  body: Schema.Struct({
    id: GitHubUserDatabaseIdFromNumber,
    login: Schema.String,
  }),
})

const failed =
  (reason: LinkProofFailed["reason"], message: string) =>
  (cause?: unknown): LinkProofFailed =>
    new LinkProofFailed({ platform: "github", reason, message, cause })

export const make = Effect.fnUntraced(function* (config: GitHubLinkConfig) {
  const http = yield* HttpClient.HttpClient
  const decodeToken = HttpClientResponse.schemaJson(TokenResponse)
  const decodeUser = HttpClientResponse.schemaJson(UserResponse)

  const authorizeUrl = (state: string) => {
    const url = new URL(GITHUB_AUTHORIZE_URL)
    url.searchParams.set("client_id", config.clientId)
    url.searchParams.set("redirect_uri", config.redirectUri)
    url.searchParams.set("state", state)
    url.searchParams.set("allow_signup", "false")
    return url.toString()
  }

  const exchange = (code: string) =>
    http
      .execute(
        HttpClientRequest.post(GITHUB_TOKEN_URL).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.bodyUrlParams(
            UrlParams.fromInput({
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
        Effect.mapError(
          failed("exchange-failed", "GitHub did not accept the authorization. Try again."),
        ),
        Effect.flatMap((response) =>
          response.body.access_token !== undefined
            ? Effect.succeed(Redacted.make(response.body.access_token))
            : Effect.fail(
                failed(
                  "exchange-failed",
                  "GitHub did not accept the authorization. Try again.",
                )(response.body.error),
              ),
        ),
      )

  const lookup = (token: Redacted.Redacted<string>) =>
    http
      .execute(
        HttpClientRequest.get(GITHUB_USER_URL).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.setHeaders({
            Accept: "application/vnd.github+json",
            "User-Agent": GITHUB_USER_AGENT,
            "X-GitHub-Api-Version": GITHUB_API_VERSION,
          }),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(decodeUser),
        Effect.mapError(failed("lookup-failed", "GitHub did not identify the authorized user.")),
        Effect.map((response): ProvenAccount => ({
          workspaceId: GITHUB_WORKSPACE_ID,
          accountId: response.body.id,
          displayName: response.body.login,
        })),
      )

  const prove = (code: string) => exchange(code).pipe(Effect.flatMap(lookup))

  const link: GitHubLink = { authorizeUrl, prove }
  return link
})
