import {
  type LinkedAccount,
  type LinkingAvailability,
  type LinkPlatform,
  type LinkReturnRequest,
  type TeammateId,
} from "@janitor/domain/Team/Account"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type * as Redacted from "effect/Redacted"
import type * as HttpClient from "effect/unstable/http/HttpClient"
import * as GitHubLink from "./Linking/GitHub.ts"
import type { LinkProofFailed, ProvenAccount } from "./Linking/Proof.ts"
import * as SlackLink from "./Linking/Slack.ts"
import { TeammateError, Teammates } from "./Teammates.ts"

/**
 * The account-linking round trip: start an attempt bound to the signed-in
 * teammate, send them to the platform, and on return consume the attempt
 * once, obtain the platform's proof, and record the link.
 */

export class AccountLinkingConfig extends Context.Service<
  AccountLinkingConfig,
  {
    readonly slack: Option.Option<SlackLink.SlackLinkConfig>
    readonly github: Option.Option<GitHubLink.GitHubLinkConfig>
  }
>()("@janitor/cluster/AccountLinking/AccountLinkingConfig") {}

/** Platform app credentials. Each platform is optional; a partial set is treated as absent. */
export interface LinkingSecrets {
  readonly slack: Option.Option<{
    readonly clientId: string
    readonly clientSecret: Redacted.Redacted<string>
    /** Comma-separated Slack team IDs whose members may link. */
    readonly workspaceIds: string
  }>
  readonly github: Option.Option<{
    readonly clientId: string
    readonly clientSecret: Redacted.Redacted<string>
  }>
  readonly initialAdminSubject: Option.Option<string>
}

export const linkingSecrets: Config.Wrap<LinkingSecrets> = {
  slack: Config.option(
    Config.unwrap({
      clientId: Config.String("JANITOR_SLACK_CLIENT_ID"),
      clientSecret: Config.Redacted("JANITOR_SLACK_CLIENT_SECRET"),
      workspaceIds: Config.String("JANITOR_SLACK_WORKSPACE_IDS"),
    }),
  ),
  github: Config.option(
    Config.unwrap({
      clientId: Config.String("JANITOR_GITHUB_OAUTH_CLIENT_ID"),
      clientSecret: Config.Redacted("JANITOR_GITHUB_OAUTH_CLIENT_SECRET"),
    }),
  ),
  initialAdminSubject: Config.option(Config.String("JANITOR_INITIAL_ADMIN_SUBJECT")),
}

/** The browser routes the platforms send people back to. */
export const SLACK_RETURN_PATH = "/account/slack/return"
export const GITHUB_RETURN_PATH = "/account/github/return"

/** Builds the linking configuration for the deployment's public origin. */
export const configLayer = (
  secrets: LinkingSecrets,
  publicOrigin: string,
): Layer.Layer<AccountLinkingConfig> =>
  Layer.succeed(AccountLinkingConfig, {
    slack: Option.map(secrets.slack, (slack) => ({
      clientId: slack.clientId,
      clientSecret: slack.clientSecret,
      redirectUri: `${publicOrigin}${SLACK_RETURN_PATH}`,
      workspaceIds: slack.workspaceIds
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    })),
    github: Option.map(secrets.github, (github) => ({
      clientId: github.clientId,
      clientSecret: github.clientSecret,
      redirectUri: `${publicOrigin}${GITHUB_RETURN_PATH}`,
    })),
  })

export class AccountLinking extends Context.Service<
  AccountLinking,
  {
    readonly availability: LinkingAvailability
    /** Returns the platform URL the browser should open. */
    readonly start: (
      teammateId: TeammateId,
      platform: LinkPlatform,
    ) => Effect.Effect<string, TeammateError>
    readonly complete: (
      teammateId: TeammateId,
      platform: LinkPlatform,
      request: LinkReturnRequest,
    ) => Effect.Effect<LinkedAccount, TeammateError>
  }
>()("@janitor/cluster/AccountLinking", {
  make: Effect.gen(function* () {
    const config = yield* AccountLinkingConfig
    const teammates = yield* Teammates

    const slack: Provider | undefined = Option.isSome(config.slack)
      ? yield* SlackLink.make(config.slack.value)
      : undefined
    const github: Provider | undefined = Option.isSome(config.github)
      ? yield* Effect.map(GitHubLink.make(config.github.value), (link): Provider => ({
          authorizeUrl: (state) => link.authorizeUrl(state),
          prove: (code) => link.prove(code),
        }))
      : undefined

    const availability: LinkingAvailability = {
      slack: slack !== undefined,
      github: github !== undefined,
    }

    const providerFor = (platform: LinkPlatform) => {
      const provider = platform === "slack" ? slack : github
      return provider === undefined ? Effect.fail(unavailable(platform)) : Effect.succeed(provider)
    }

    const start = (teammateId: TeammateId, platform: LinkPlatform) =>
      Effect.gen(function* () {
        const provider = yield* providerFor(platform)
        const attempt = yield* teammates.beginLink(teammateId, platform)
        return provider.authorizeUrl(attempt.state, attempt.nonce)
      })

    const complete = (teammateId: TeammateId, platform: LinkPlatform, request: LinkReturnRequest) =>
      Effect.gen(function* () {
        const provider = yield* providerFor(platform)
        // Consumed before the proof so a replayed callback cannot try twice.
        const { nonce } = yield* teammates.consumeLinkAttempt(teammateId, platform, request.state)
        const proven = yield* provider.prove(request.code, nonce).pipe(
          Effect.tapError((error) =>
            Effect.logWarning("Account link proof failed", error.reason).pipe(
              Effect.annotateLogs({ platform, teammateId }),
            ),
          ),
          Effect.mapError(proofFailed),
        )
        return yield* teammates.link(teammateId, { platform, ...proven })
      })

    return { availability, start, complete }
  }),
}) {
  static readonly layer: Layer.Layer<
    AccountLinking,
    never,
    AccountLinkingConfig | Teammates | HttpClient.HttpClient
  > = Layer.effect(this, this.make)
}

const unavailable = (platform: LinkPlatform) =>
  new TeammateError({
    reason: "unavailable",
    message: `${platform === "slack" ? "Slack" : "GitHub"} account linking is not configured for this deployment.`,
  })

const proofFailed = (error: LinkProofFailed) =>
  new TeammateError({ reason: "rejected", message: error.message })

interface Provider {
  readonly authorizeUrl: (state: string, nonce: string) => string
  readonly prove: (code: string, nonce: string) => Effect.Effect<ProvenAccount, LinkProofFailed>
}
