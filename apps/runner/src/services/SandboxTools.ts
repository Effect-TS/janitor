// The tools the model receives, each backed by the session's Linux sandbox.
// Repository commands run unprivileged inside the checkout with a finite
// timeout; file tools stay inside the repository; publication goes through the
// Durable Object's authorized path. No tool carries GitHub credentials.
import { Effect, Schema } from "effect"
import { Tool } from "@opencode/sdk/effect"
import type { Result as ToolResult } from "@opencode/schema/tool"
import type { Publication } from "../Publication.ts"
import {
  REPOSITORY_DIR,
  SandboxWorkspace,
  WORKSPACE_USER,
  asWorkspaceUser,
  shellQuote,
  type WorkspaceError,
} from "./SandboxWorkspace.ts"

export interface SandboxToolOptions {
  readonly workspace: SandboxWorkspace["Service"]
  /** Resolves once the turn's checkout is prepared; tools never touch the workspace before it. */
  readonly ready: Effect.Effect<void, WorkspaceError>
  /** Null for conversation-only sessions: no repository tools are offered. */
  readonly publication: Publication | null
  readonly hasRepository: boolean
  readonly commandTimeoutMs: number
  /** Records a durable publication event beside the tool's native receipt. */
  readonly published: (publication: unknown) => void
  readonly journal: (kind: string, data?: unknown) => void
}

const OUTPUT_LIMIT = 30_000
const READ_LIMIT = 2000
const MAX_FILE_BYTES = 1024 * 1024
const MAX_COMMAND_TIMEOUT_MS = 30 * 60_000

export const SANDBOX_TOOLS: ReadonlyArray<string> = [
  "bash",
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "list",
  "publish",
]

const toolError = (cause: unknown) =>
  new Tool.Error({
    message:
      cause instanceof Tool.Error
        ? cause.message
        : cause instanceof Error
          ? cause.message
          : "The tool failed",
  })

/** Resolves a model-supplied path inside the repository, refusing escapes. */
export const repositoryPath = (input: string | undefined): string => {
  const raw = (input ?? "").trim()
  const stripped = raw.startsWith(REPOSITORY_DIR)
    ? raw.slice(REPOSITORY_DIR.length).replace(/^\/+/, "")
    : raw
  if (stripped.startsWith("/") || stripped.includes("\0") || stripped.length > 4096)
    throw new Tool.Error({ message: "Paths must be relative to the repository" })
  const parts = stripped.split("/").filter((part) => part !== "" && part !== ".")
  if (parts.includes("..")) throw new Tool.Error({ message: "Paths may not leave the repository" })
  return parts.length === 0 ? REPOSITORY_DIR : `${REPOSITORY_DIR}/${parts.join("/")}`
}

const truncate = (text: string, limit = OUTPUT_LIMIT) =>
  text.length > limit ? `${text.slice(0, limit)}\n[Output truncated at ${limit} characters.]` : text

export const makeSandboxTools = (options: SandboxToolOptions): ReadonlyArray<Tool.Info> => {
  const { workspace } = options
  const run = <A>(operation: Effect.Effect<A, WorkspaceError | Tool.Error>) =>
    options.ready.pipe(
      Effect.andThen(operation),
      Effect.mapError(toolError),
      // Interruption stops the sandbox processes the tool started.
      Effect.onInterrupt(() => workspace.stopProcesses.pipe(Effect.ignore)),
    )
  const exec = (command: string, cwd: string, timeoutMs: number) =>
    workspace.exec(asWorkspaceUser(command, cwd), { cwd, timeoutMs, user: "root" })

  const tool = <I extends Schema.Top>(
    name: string,
    description: string,
    input: I,
    execute: (input: I["Type"]) => Effect.Effect<ToolResult, WorkspaceError | Tool.Error>,
  ): Tool.Info =>
    ({
      name,
      description,
      input,
      options: { permission: name, codemode: false },
      execute: (value: unknown) => run(execute(value as I["Type"])),
    }) as unknown as Tool.Info

  if (!options.hasRepository) return []

  const tools: Array<Tool.Info> = [
    tool(
      "bash",
      `Run a shell command in the repository checkout as an unprivileged user. Commands time out after ${Math.round(options.commandTimeoutMs / 60_000)} minutes by default; a timeout is reported as an error you can handle. Background processes are stopped when the turn ends. There are no GitHub credentials; use publish to push.`,
      Schema.Struct({
        command: Schema.String,
        cwd: Schema.optionalKey(Schema.String),
        timeoutMs: Schema.optionalKey(Schema.Int),
      }),
      (input) =>
        Effect.gen(function* () {
          const cwd = repositoryPath(input.cwd)
          const timeoutMs = Math.min(
            Math.max(1_000, input.timeoutMs ?? options.commandTimeoutMs),
            MAX_COMMAND_TIMEOUT_MS,
          )
          const outcome = yield* exec(input.command, cwd, timeoutMs)
          const combined = [outcome.stdout, outcome.stderr && `stderr:\n${outcome.stderr}`]
            .filter(Boolean)
            .join("\n")
          if (outcome.timedOut)
            return yield* Effect.fail(
              new Tool.Error({
                message: `Command exceeded ${Math.round(timeoutMs / 1000)} seconds and was stopped.\n${truncate(combined)}`,
              }),
            )
          return {
            content: `${truncate(combined)}${combined ? "\n" : ""}[exit code ${outcome.exitCode}]`,
            metadata: { exitCode: outcome.exitCode, durationMs: outcome.durationMs },
          }
        }),
    ),
    tool(
      "read",
      "Read a UTF-8 file from the repository. offset and limit are line numbers.",
      Schema.Struct({
        path: Schema.String,
        offset: Schema.optionalKey(Schema.Int),
        limit: Schema.optionalKey(Schema.Int),
      }),
      (input) =>
        Effect.gen(function* () {
          const path = repositoryPath(input.path)
          const content = yield* workspace.readFile(path)
          if (content === null)
            return yield* Effect.fail(new Tool.Error({ message: `${input.path} was not found` }))
          if (content.length > MAX_FILE_BYTES)
            return yield* Effect.fail(
              new Tool.Error({
                message: "The file is larger than 1 MiB; use bash to inspect parts of it",
              }),
            )
          const lines = content.split("\n")
          const offset = Math.max(0, input.offset ?? 0)
          const limit = Math.min(Math.max(1, input.limit ?? READ_LIMIT), READ_LIMIT)
          const slice = lines.slice(offset, offset + limit)
          const numbered = slice
            .map((line, index) => `${String(offset + index + 1).padStart(5)}| ${line}`)
            .join("\n")
          const more =
            offset + limit < lines.length
              ? `\n[${lines.length - offset - limit} more lines; use offset to continue.]`
              : ""
          return { content: numbered + more }
        }),
    ),
    tool(
      "write",
      "Create or replace a UTF-8 file in the repository.",
      Schema.Struct({ path: Schema.String, content: Schema.String }),
      (input) =>
        Effect.gen(function* () {
          const path = repositoryPath(input.path)
          yield* workspace.exec(`mkdir -p ${shellQuote(path.slice(0, path.lastIndexOf("/")))}`, {
            user: "root",
          })
          yield* workspace.writeFile(path, input.content)
          yield* workspace.exec(`chown ${WORKSPACE_USER}:${WORKSPACE_USER} ${shellQuote(path)}`, {
            user: "root",
          })
          return { content: `Wrote ${input.path}` }
        }),
    ),
    tool(
      "edit",
      "Replace exact text in a repository file. oldText must occur exactly once unless replaceAll is true.",
      Schema.Struct({
        path: Schema.String,
        oldText: Schema.String,
        newText: Schema.String,
        replaceAll: Schema.optionalKey(Schema.Boolean),
      }),
      (input) =>
        Effect.gen(function* () {
          if (input.oldText === "")
            return yield* Effect.fail(
              new Tool.Error({ message: "An edit requires nonempty oldText" }),
            )
          const path = repositoryPath(input.path)
          const content = yield* workspace.readFile(path)
          if (content === null)
            return yield* Effect.fail(new Tool.Error({ message: `${input.path} was not found` }))
          const parts = content.split(input.oldText)
          if (parts.length === 1 || (!input.replaceAll && parts.length !== 2))
            return yield* Effect.fail(
              new Tool.Error({
                message: "oldText must match exactly once; read the current file before retrying",
              }),
            )
          yield* workspace.writeFile(path, parts.join(input.newText))
          yield* workspace.exec(`chown ${WORKSPACE_USER}:${WORKSPACE_USER} ${shellQuote(path)}`, {
            user: "root",
          })
          return { content: `Edited ${input.path}` }
        }),
    ),
    tool(
      "glob",
      "List repository files matching a glob pattern (ripgrep syntax), ignoring Git-ignored files. Results are bounded.",
      Schema.Struct({ pattern: Schema.String, path: Schema.optionalKey(Schema.String) }),
      (input) =>
        Effect.gen(function* () {
          const cwd = repositoryPath(input.path)
          const outcome = yield* exec(
            `rg --files --glob ${shellQuote(input.pattern)} | head -n 500`,
            cwd,
            60_000,
          )
          return { content: outcome.stdout.trim() || "No files matched." }
        }),
    ),
    tool(
      "grep",
      "Search repository content with a regular expression (ripgrep). Results are bounded; narrow the path for large repositories.",
      Schema.Struct({
        pattern: Schema.String,
        path: Schema.optionalKey(Schema.String),
        glob: Schema.optionalKey(Schema.String),
      }),
      (input) =>
        Effect.gen(function* () {
          const cwd = repositoryPath(input.path)
          const glob = input.glob === undefined ? "" : ` --glob ${shellQuote(input.glob)}`
          const outcome = yield* exec(
            `rg -n --max-columns 400 --max-count 20${glob} -e ${shellQuote(input.pattern)} . | head -n 200`,
            cwd,
            60_000,
          )
          return { content: truncate(outcome.stdout.trim()) || "No matches." }
        }),
    ),
    tool(
      "list",
      "List a repository directory.",
      Schema.Struct({ path: Schema.optionalKey(Schema.String) }),
      (input) =>
        Effect.gen(function* () {
          const cwd = repositoryPath(input.path)
          const outcome = yield* exec("ls -1Ap | head -n 500", cwd, 30_000)
          return { content: outcome.stdout.trim() || "Empty directory." }
        }),
    ),
  ]
  if (options.publication !== null) {
    const publication = options.publication
    tools.push(
      tool(
        "publish",
        "Publish the checkout's commits through GitHub to the session's existing PR or its designated branch. Uncommitted changes are committed first. Describe the changes and the checks you actually ran; never claim tests passed unless you observed their results. Retry this tool to reconcile an uncertain response. Humans decide whether to merge.",
        Schema.Struct({
          title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
          body: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(10000)),
          base: Schema.optionalKey(Schema.String),
        }),
        (input) =>
          Effect.gen(function* () {
            // Nothing else may be writing the checkout while its commits are published.
            yield* workspace.stopProcesses
            const published = yield* Effect.tryPromise({
              try: () => publication.publish(input),
              catch: toolError,
            })
            options.published(published.metadata.publication)
            return published
          }),
      ),
    )
  }
  return tools
}
