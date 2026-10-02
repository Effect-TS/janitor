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
import type * as HttpClient from "effect/http/HttpClient"
import * as GitHubLink from "./Linking/GitHub.ts"
import type { LinkProofFailed, ProvenAccount } from "./Linking/Proof.ts"
import { TeammateError, Teammates } from "./Teammates.ts"

/**
 * The account-linking round trip: start an attempt bound to the signed-in
 * teammate, send them to the platform, and on return consume the attempt
 * once, obtain the platform's proof, and record the link.
 */

export class AccountLinkingConfig extends Context.Service<
  AccountLinkingConfig,
  {
    readonly github: Option.Option<GitHubLink.GitHubLinkConfig>
  }
>()("@janitor/cluster/AccountLinking/AccountLinkingConfig") {}

/** Platform app credentials. Each platform is optional; a partial set is treated as absent. */
export interface LinkingSecrets {
  readonly github: Option.Option<{
    readonly clientId: string
    readonly clientSecret: Redacted.Redacted<string>
  }>
}

export const linkingSecrets: Config.Wrap<LinkingSecrets> = {
  github: Config.option(
    Config.unwrap({
      clientId: Config.String("GITHUB_OAUTH_CLIENT_ID"),
      clientSecret: Config.Redacted("GITHUB_OAUTH_CLIENT_SECRET"),
    }),
  ),
}

/** The browser route GitHub sends people back to. */
export const GITHUB_RETURN_PATH = "/account/github/return"

/** Builds the linking configuration for the deployment's public origin. */
export const configLayer = (
  secrets: LinkingSecrets,
  publicOrigin: string,
): Layer.Layer<AccountLinkingConfig> =>
  Layer.succeed(AccountLinkingConfig, {
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

    const maybeGithub: Option.Option<Provider> = yield* Option.match(config.github, {
      onNone: () => Effect.succeed(Option.none<Provider>()),
      onSome: (github) =>
        Effect.map(GitHubLink.make(github), (link) =>
          Option.some<Provider>({
            authorizeUrl: (state) => link.authorizeUrl(state),
            prove: (code) => link.prove(code),
          }),
        ),
    })

    const availability: LinkingAvailability = { github: Option.isSome(maybeGithub) }

    const providerFor = (platform: LinkPlatform) =>
      Option.match(maybeGithub, {
        onNone: () => Effect.fail(unavailable(platform)),
        onSome: Effect.succeed,
      })

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

const unavailable = (_platform: LinkPlatform) =>
  new TeammateError({
    reason: "unavailable",
    message: "GitHub account linking is not configured for this deployment.",
  })

const proofFailed = (error: LinkProofFailed) =>
  new TeammateError({ reason: "rejected", message: error.message })

interface Provider {
  readonly authorizeUrl: (state: string, nonce: string) => string
  readonly prove: (code: string, nonce: string) => Effect.Effect<ProvenAccount, LinkProofFailed>
}
