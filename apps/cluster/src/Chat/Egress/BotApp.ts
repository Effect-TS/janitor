import {
  GITHUB_API_BASE_URL,
  GITHUB_REQUEST_HEADERS,
  GitHubInstallationAccessToken,
} from "@janitor/domain/GitHub/Api"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as GitHubAppAuth from "../../GitHub/AppAuth.ts"
import type { ChatEgressSecrets } from "../Config.ts"

/**
 * The chat bot's credentials (EFF-3017): its own GitHub App, separate from
 * janitor's, and the Janitor user's Multica PAT. Both are optional, so the
 * deployment runs before they exist: without the App, GitHub gets no
 * credential; without the PAT, Multica gets none.
 */

/** A read-only and a write installation token for one org, both covering all its repos. */
export interface OrgTokens {
  readonly read: string
  readonly write: string
  /** When the first of the two expires, in epoch milliseconds. */
  readonly expiresAt: number
}

/** Minting or revoking a token failed. Carries a fixed category, never the request. */
export class BotAppError extends Schema.TaggedError<BotAppError>()("BotAppError", {
  reason: Schema.String,
}) {}

/**
 * What the read token may do: everything the App can read, and nothing it
 * can write. The write token takes the App's full permissions.
 */
const READ_PERMISSIONS = {
  contents: "read",
  pull_requests: "read",
  issues: "read",
  actions: "read",
  checks: "read",
  statuses: "read",
  metadata: "read",
} as const

export interface BotApp {
  /** Mints an org's two tokens, or `undefined` when the App isn't installed on it. */
  readonly mint: (org: string) => Effect.Effect<OrgTokens | undefined, BotAppError>
  readonly revoke: (token: string) => Effect.Effect<void, BotAppError>
}

export class ChatCredentials extends Context.Service<
  ChatCredentials,
  {
    readonly app: BotApp | undefined
    /** `CHAT_MULTICA_TOKEN`, or empty when unset. */
    readonly multicaToken: string
  }
>()("@janitor/cluster/Chat/Egress/ChatCredentials") {
  /** No App and no PAT: GitHub and Multica get no credential. */
  static readonly disabled = Layer.succeed(ChatCredentials, { app: undefined, multicaToken: "" })

  static readonly layerFrom = (
    secrets: ChatEgressSecrets,
  ): Layer.Layer<ChatCredentials, never, HttpClient.HttpClient> =>
    Layer.effect(
      ChatCredentials,
      Effect.gen(function* () {
        const multicaToken = Option.match(secrets.multicaToken, {
          onNone: () => "",
          onSome: Redacted.value,
        })
        if (Option.isNone(secrets.app)) return { app: undefined, multicaToken }
        // An unusable private key is a deployment defect, not a runtime condition.
        const auth = yield* GitHubAppAuth.make(secrets.app.value).pipe(Effect.orDie)
        const app = yield* makeBotApp(auth)
        return { app, multicaToken }
      }),
    )
}

const decodeInstallation = HttpClientResponse.schemaBodyJson(Schema.Struct({ id: Schema.Int }))
const decodeToken = HttpClientResponse.schemaBodyJson(GitHubInstallationAccessToken)

const makeBotApp = Effect.fnUntraced(function* (auth: GitHubAppAuth.GitHubAppAuth["Service"]) {
  const http = yield* HttpClient.HttpClient
  /** Installation ids by lowercased org; `null` where the App isn't installed. */
  const installations = new Map<string, number | null>()

  const failed = (reason: string) => () => new BotAppError({ reason })

  const installation = (org: string) =>
    Effect.gen(function* () {
      const known = installations.get(org.toLowerCase())
      if (known !== undefined) return known
      const jwt = yield* auth.appJwt.pipe(Effect.mapError(failed("signing the App JWT failed")))
      const response = yield* http
        .execute(
          HttpClientRequest.get(
            `${GITHUB_API_BASE_URL}/orgs/${encodeURIComponent(org)}/installation`,
          ).pipe(
            HttpClientRequest.bearerToken(Redacted.value(jwt)),
            HttpClientRequest.setHeaders(GITHUB_REQUEST_HEADERS),
          ),
        )
        .pipe(Effect.mapError(failed("the installation lookup failed")))
      if (response.status === 404) {
        installations.set(org.toLowerCase(), null)
        return null
      }
      if (response.status !== 200) {
        return yield* new BotAppError({
          reason: `the installation lookup answered ${response.status}`,
        })
      }
      const { id } = yield* decodeInstallation(response).pipe(
        Effect.mapError(failed("the installation lookup was unreadable")),
      )
      installations.set(org.toLowerCase(), id)
      return id
    })

  const token = (installationId: number, permissions?: typeof READ_PERMISSIONS) =>
    Effect.gen(function* () {
      const jwt = yield* auth.appJwt.pipe(Effect.mapError(failed("signing the App JWT failed")))
      const request = HttpClientRequest.post(
        `${GITHUB_API_BASE_URL}/app/installations/${installationId}/access_tokens`,
      ).pipe(
        HttpClientRequest.bearerToken(Redacted.value(jwt)),
        HttpClientRequest.setHeaders(GITHUB_REQUEST_HEADERS),
      )
      const body =
        permissions === undefined
          ? request
          : yield* HttpClientRequest.bodyJson(request, { permissions }).pipe(Effect.orDie)
      return yield* http
        .execute(body)
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(decodeToken),
          Effect.mapError(failed("the installation token request failed")),
        )
    })

  const mint = (org: string) =>
    Effect.gen(function* () {
      const id = yield* installation(org)
      if (id === null) return undefined
      const [read, write] = yield* Effect.all([token(id, READ_PERMISSIONS), token(id)], {
        concurrency: 2,
      })
      return {
        read: Redacted.value(read.token),
        write: Redacted.value(write.token),
        expiresAt: Math.min(
          DateTime.toEpochMillis(read.expiresAt),
          DateTime.toEpochMillis(write.expiresAt),
        ),
      }
    })

  const revoke = (value: string) =>
    auth
      .revokeInstallationToken(Redacted.make(value))
      .pipe(Effect.mapError(failed("revoking a token failed")))

  return { mint, revoke } satisfies BotApp
})
