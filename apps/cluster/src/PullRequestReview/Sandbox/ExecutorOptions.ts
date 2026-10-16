import type { ExcludableTool } from "clanka/AgentTools"
import type * as Duration from "effect/Duration"

/** Built-in tools janitor's sandbox leaves out (EFF-1646). */
const EXCLUDED_TOOLS: ReadonlyArray<ExcludableTool> = [
  "gh",
  "webSearch",
  "fetchMarkdown",
  "delegate",
]

/** The most characters of one command's output the sandbox keeps. */
const COMMAND_OUTPUT_CHARS = 30_000

/**
 * The sandbox executor's tools and limits: every command and script is capped
 * at `commandTimeout`. The container serves its executor with these, so the
 * model never sees a left-out tool.
 */
export const executorOptions = (commandTimeout: Duration.Duration) => ({
  excludeTools: EXCLUDED_TOOLS,
  limits: {
    commandTimeout,
    scriptTimeout: commandTimeout,
    commandOutputChars: COMMAND_OUTPUT_CHARS,
  },
})
