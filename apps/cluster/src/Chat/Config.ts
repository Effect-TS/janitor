import * as Config from "effect/Config"
import * as Duration from "effect/Duration"
import * as Schema from "effect/Schema"

/**
 * Deployment-wide chat bot settings (EFF-3015). Every value has a default.
 */

const Positive = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2147483647 }))

const count = (name: string, fallback: number) =>
  Config.schema(Positive, name).pipe(Config.withDefault(fallback))

const seconds = (name: string, fallback: number) =>
  count(name, fallback).pipe(Config.map(Duration.seconds))

/**
 * `CHAT_SANDBOX_MAX_INSTANCES`: how many chat sandbox containers may run at
 * once. A class of its own, so chat can't starve PR review. Read when the
 * container application deploys.
 */
export const chatSandboxMaxInstances: Config.Config<number> = count(
  "CHAT_SANDBOX_MAX_INSTANCES",
  10,
)

/**
 * `CHAT_COMMAND_TIMEOUT_SECONDS`: the longest one `bash` command or `execute`
 * script may run. The container's image carries it from the deploy.
 */
export const chatCommandTimeout: Config.Config<Duration.Duration> = seconds(
  "CHAT_COMMAND_TIMEOUT_SECONDS",
  300,
)

/** The Multica workspace the bot is a member of: Effectful's. */
const DEFAULT_MULTICA_WORKSPACE_ID = "6eac4221-824e-4b2f-8517-546454766676"

/**
 * `CHAT_MULTICA_WORKSPACE_ID`: the Multica workspace the sandbox's `multica`
 * CLI acts in.
 */
export const chatMulticaWorkspaceId: Config.Config<string> = Config.NonEmptyString(
  "CHAT_MULTICA_WORKSPACE_ID",
).pipe(Config.withDefault(DEFAULT_MULTICA_WORKSPACE_ID))
