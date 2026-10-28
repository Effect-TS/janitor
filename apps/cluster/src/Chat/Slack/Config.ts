import * as Context from "effect/Context"
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
>()("@janitor/cluster/Chat/Slack/Config/SlackConfig") {}
