import * as Context from "effect/Context"
import type * as Redacted from "effect/Redacted"

export class SlackConfig extends Context.Service<
  SlackConfig,
  {
    readonly workspaceId: string
    readonly appId: string
    readonly botUserId: string
    readonly signingSecret: Redacted.Redacted<string>
    readonly token: Redacted.Redacted<string>
    readonly accountUrl: string
  }
>()("@janitor/cluster/Slack/Config") {}
