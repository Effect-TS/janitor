import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
import type * as Option from "effect/Option"
import type * as Redacted from "effect/Redacted"

/**
 * Slack's settings (EFF-3019): `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`,
 * `SLACK_WORKSPACE_ID` and `SLACK_APP_ID`. Slack is off while any of them
 * is unset, and then nothing reads them.
 */
export class SlackConfig extends Context.Service<
  SlackConfig,
  {
    readonly signingSecret: Redacted.Redacted<string>
    readonly botToken: Redacted.Redacted<string>
    /** The envelope's `team_id`, and the team an admitted user belongs to. */
    readonly workspaceId: string
    /** The envelope's `api_app_id`. */
    readonly appId: string
  }
>()("@janitor/cluster/Chat/Slack/Config/SlackConfig") {
  static readonly layerFrom = (config: SlackConfig["Service"]): Layer.Layer<SlackConfig> =>
    Layer.succeed(this, config)
}

/**
 * Slack's settings, when all four are set. The Worker reads them during init,
 * and only while the chat bot is on, so Alchemy binds them at deploy time.
 */
export const slackSettings: Config.Config<Option.Option<SlackConfig["Service"]>> = Config.option(
  Config.all({
    signingSecret: Config.Redacted("SLACK_SIGNING_SECRET"),
    botToken: Config.Redacted("SLACK_BOT_TOKEN"),
    workspaceId: Config.NonEmptyString("SLACK_WORKSPACE_ID"),
    appId: Config.NonEmptyString("SLACK_APP_ID"),
  }),
)
