import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"

/**
 * Provisioning a chat sandbox (EFF-3016): the Worker posts the sandbox's
 * environment and skills to the container's `/provision`, and the container
 * applies them. Nothing is checked out; the model clones on demand.
 *
 * The environment is what lets `gh` and `multica` run as the bot without
 * holding a credential: the egress proxy swaps the placeholders for real
 * tokens. Any of the daemon-task variables, or a daemon task marker file,
 * would put the `multica` CLI into daemon-task mode, so the container removes
 * them all, whatever the request says.
 */

/** Where the sandbox's `multica` CLI sends its requests. */
export const MULTICA_SERVER_URL = "https://api.multica.ai"

const GIT_NAME = "Effect Bot"
const GIT_EMAIL = "tech-ops@effectful.co"

/** The variables that put the `multica` CLI into daemon-task mode. Never set in a sandbox. */
export const DAEMON_TASK_VARIABLES: ReadonlyArray<string> = [
  "MULTICA_DAEMON_PORT",
  "MULTICA_AGENT_ID",
  "MULTICA_TASK_ID",
  "MULTICA_TASK_CONFIG_ROOT",
]

/** The marker the daemon writes into a task's directory tree. Never present in a sandbox. */
export const DAEMON_TASK_MARKER = ".multica/daemon_task_context.json"

/** A skill folder name, as in `.agents/skills/<name>`. */
const SkillName = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/))

/** A relative path inside a skill folder, with no `.` or `..` segments. */
const SkillPath = Schema.String.check(
  Schema.makeFilter(
    (path) =>
      path.length > 0 &&
      !path.startsWith("/") &&
      path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    { expected: "a relative path inside the skill folder" },
  ),
)

export const SkillFile = Schema.Struct({
  path: SkillPath,
  content: Schema.String,
})
export type SkillFile = typeof SkillFile.Type

export const Skill = Schema.Struct({
  name: SkillName,
  files: Schema.Array(SkillFile),
})
export type Skill = typeof Skill.Type

export const ProvisionRequest = Schema.Struct({
  /** Set in the container's process environment, which every command inherits. */
  environment: Schema.Record(Schema.String, Schema.String),
  /** Written to `$HOME/.agents/skills/<name>`, replacing any folder there. */
  skills: Schema.Array(Skill),
})
export type ProvisionRequest = typeof ProvisionRequest.Type

/**
 * The sandbox environment from the spec. The tokens are placeholders: the
 * CLIs need one to send a request at all, and the egress proxy replaces the
 * `Authorization` header they send.
 */
export const sandboxEnvironment = (multicaWorkspaceId: string): Record<string, string> => ({
  GIT_AUTHOR_NAME: GIT_NAME,
  GIT_AUTHOR_EMAIL: GIT_EMAIL,
  GIT_COMMITTER_NAME: GIT_NAME,
  GIT_COMMITTER_EMAIL: GIT_EMAIL,
  GH_TOKEN: "placeholder",
  MULTICA_TOKEN: "mul_placeholder",
  MULTICA_SERVER_URL,
  MULTICA_WORKSPACE_ID: multicaWorkspaceId,
})

/** What the Worker posts to `/provision`: the sandbox environment and its skills (`Skills.ts`). */
export const provisionRequest = (
  multicaWorkspaceId: string,
  skills: ReadonlyArray<Skill>,
): ProvisionRequest => ({
  environment: sandboxEnvironment(multicaWorkspaceId),
  skills,
})

/**
 * Applies a provisioning request inside the container: sets the environment
 * in `env` (the process's), drops the daemon-task variables and markers, and
 * writes the skill folders under `home`. Idempotent, so the workspace can
 * retry it.
 */
export const applyProvision = Effect.fnUntraced(function* (options: {
  readonly request: ProvisionRequest
  readonly env: Record<string, string | undefined>
  readonly home: string
  /** Where the model's commands run; a marker here would be found too. */
  readonly workspace: string
}) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  for (const [name, value] of Object.entries(options.request.environment)) {
    options.env[name] = value
  }
  for (const name of DAEMON_TASK_VARIABLES) delete options.env[name]
  for (const root of [options.home, options.workspace]) {
    yield* fs.remove(path.join(root, DAEMON_TASK_MARKER), { force: true })
  }
  for (const skill of options.request.skills) {
    const folder = path.join(options.home, ".agents", "skills", skill.name)
    yield* fs.remove(folder, { recursive: true, force: true })
    for (const file of skill.files) {
      const target = path.join(folder, file.path)
      yield* fs.makeDirectory(path.dirname(target), { recursive: true })
      yield* fs.writeFileString(target, file.content)
    }
  }
})
