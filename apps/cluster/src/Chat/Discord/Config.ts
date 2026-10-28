import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
import type * as Option from "effect/Option"
import type * as Redacted from "effect/Redacted"

/**
 * Discord's settings (EFF-3020): `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID` and
 * `DISCORD_ROLE_ID`. Discord is off while any of them is unset, and then
 * nothing reads them.
 */
export class DiscordBotConfig extends Context.Service<
  DiscordBotConfig,
  {
    readonly botToken: Redacted.Redacted<string>
    /** The one guild the bot works in; messages from any other are refused. */
    readonly guildId: string
    /** The role in `member.roles` that admits an author. */
    readonly roleId: string
  }
>()("@janitor/cluster/Chat/Discord/Config/DiscordBotConfig") {
  static readonly layerFrom = (
    config: DiscordBotConfig["Service"],
  ): Layer.Layer<DiscordBotConfig> => Layer.succeed(this, config)
}

/** Discord's settings, when all three are set. */
export const discordSettings: Config.Config<Option.Option<DiscordBotConfig["Service"]>> =
  Config.option(
    Config.all({
      botToken: Config.Redacted("DISCORD_BOT_TOKEN"),
      guildId: Config.NonEmptyString("DISCORD_GUILD_ID"),
      roleId: Config.NonEmptyString("DISCORD_ROLE_ID"),
    }),
  )
