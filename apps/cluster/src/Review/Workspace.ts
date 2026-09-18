import type { ValidatedPatch, TestAttempt } from "@janitor/domain/Review/Reproduction"
import type { Sandbox } from "@janitor/alchemy/AI/Sandbox"
import * as Context from "effect/Context"
import * as Clock from "effect/Clock"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

/**
 * The run's sandbox workspace (ADR 0009): an isolated, ephemeral checkout of
 * the recorded default-branch commit with inspection and reproduction tools. The
 * checkout is fetched by Git inside the sandbox without any credential, so
 * nothing in it can reach GitHub, the model or Janitor's secrets, and no
 * repository hook or script runs outside the sandbox. Losing the workspace
 * is detectable: the marker written when provisioning finished is gone.
 */

export interface ProvisionRequest {
  /** The public clone URL trusted code derived from the repository's name. */
  readonly remoteUrl: string
  readonly commitSha: string
}

export interface ExecutionRequest {
  readonly remoteUrl: string
  readonly id: string
  readonly command: string
  readonly kind: "setup" | "test"
  readonly testPath: string | null
  readonly commitSha: string
  readonly patch: ValidatedPatch | null
  readonly timeout: number
}

export type ProvisionOutcome =
  | { readonly _tag: "Provisioned" }
  | { readonly _tag: "Failed"; readonly reason: string }

export type WorkspaceStatus =
  | { readonly _tag: "Absent" }
  | { readonly _tag: "Ready"; readonly commitSha: string }

export interface ReviewWorkspace {
  readonly provision: (request: ProvisionRequest) => Effect.Effect<ProvisionOutcome, string>
  readonly status: Effect.Effect<WorkspaceStatus, string>
  /** Entries of a directory, one per line, `.git` excluded. */
  readonly listFiles: (path: string) => Effect.Effect<string, string>
  /** Numbered lines of a text file from `offset` (1-based), at most `limit` lines. */
  readonly readFile: (
    path: string,
    options?: { readonly offset?: number | undefined; readonly limit?: number | undefined },
  ) => Effect.Effect<string, string>
  /** ripgrep matches of a pattern under a path, bounded. */
  readonly search: (pattern: string, path?: string) => Effect.Effect<string, string>
  readonly execute: (request: ExecutionRequest) => Effect.Effect<TestAttempt, string>
  /** Removes the checkout; idempotent. */
  readonly release: Effect.Effect<void, string>
}

/** How the cluster reaches a run's workspace; production keys a container by run. */
export class ReviewWorkspaces extends Context.Service<
  ReviewWorkspaces,
  { readonly open: (runId: string) => ReviewWorkspace }
>()("@janitor/cluster/Review/ReviewWorkspaces") {}

const MARKER = ".git/janitor-review.json"
const Marker = Schema.fromJsonString(
  Schema.Struct({
    state: Schema.Literals(["pending", "ready"]),
    remoteUrl: Schema.String,
    commitSha: Schema.String,
  }),
)

export const LIST_LIMIT = 500
export const READ_LINE_LIMIT = 200
export const READ_CHAR_LIMIT = 12_000
export const SEARCH_CHAR_LIMIT = 8_000
const FETCH_TIMEOUT = 300_000

const bounded = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit)}\n[output truncated; narrow the request]` : text

/** A workspace over one sandbox; the sandbox belongs to exactly one run. */
export const makeReviewWorkspace = (sandbox: Sandbox["Service"]): ReviewWorkspace => {
  const stopped = Deferred.makeUnsafe<never, string>()
  const git = (args: ReadonlyArray<string>, timeout = 120_000) =>
    Effect.gen(function* () {
      const result = yield* sandbox.exec("git", ["-c", "core.hooksPath=/dev/null", ...args], {
        timeout,
        env: { GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" },
        maxRetainedBytes: 16_000,
      })
      if (!result.success)
        return yield* Effect.fail(
          `git ${args.join(" ")} exited ${result.exitCode}: ${result.stderr.trim()}`,
        )
      return result.stdout.trim()
    })

  const marker = Effect.gen(function* () {
    if (!(yield* sandbox.exists(MARKER))) return Option.none<typeof Marker.Type>()
    const text = yield* sandbox.readFile(MARKER)
    return Option.some(yield* Schema.decodeEffect(Marker)(text).pipe(Effect.mapError(String)))
  })

  const writeMarker = (value: typeof Marker.Type) =>
    Schema.encodeEffect(Marker)(value).pipe(
      Effect.mapError(String),
      Effect.flatMap((text) => sandbox.writeFile(MARKER, text)),
    )

  const status: Effect.Effect<WorkspaceStatus, string> = Effect.map(marker, (current) =>
    Option.isSome(current) && current.value.state === "ready"
      ? { _tag: "Ready", commitSha: current.value.commitSha }
      : { _tag: "Absent" },
  )

  const wipe = sandbox
    .exec(
      "find",
      [".", "-mindepth", "1", "-maxdepth", "1", "-exec", "rm", "-rf", "--", "{}", "+"],
      {
        timeout: 120_000,
      },
    )
    .pipe(
      Effect.flatMap((result) =>
        result.success ? Effect.void : Effect.fail(`release failed: ${result.stderr.trim()}`),
      ),
    )

  const provision = (request: ProvisionRequest) =>
    Effect.gen(function* () {
      const current = yield* marker
      if (Option.isSome(current)) {
        if (
          current.value.state === "ready" &&
          current.value.commitSha === request.commitSha &&
          current.value.remoteUrl === request.remoteUrl
        )
          return { _tag: "Provisioned" } as const
        // A pending or foreign checkout is discarded; the sandbox is this run's.
        yield* wipe
      } else if ((yield* sandbox.listFiles(".")).length > 0) {
        return { _tag: "Failed", reason: "The sandbox workspace is not empty." } as const
      }
      yield* git(["init", "-q", "."])
      yield* writeMarker({ state: "pending", ...request })
      yield* git(["remote", "add", "origin", request.remoteUrl])
      yield* git(["fetch", "-q", "--depth", "1", "origin", request.commitSha], FETCH_TIMEOUT)
      yield* git(["checkout", "-q", "--force", "-B", "janitor/review", "FETCH_HEAD"])
      const head = yield* git(["rev-parse", "HEAD"])
      if (head !== request.commitSha)
        return yield* Effect.fail(`checked out ${head} instead of ${request.commitSha}`)
      yield* writeMarker({ state: "ready", ...request })
      return { _tag: "Provisioned" } as const
    }).pipe(
      Effect.catch((reason) =>
        Effect.succeed({ _tag: "Failed", reason: bounded(reason, 2_000) } as const),
      ),
    )

  const listFiles = (path: string) =>
    Effect.gen(function* () {
      const entries = yield* sandbox.listFiles(path === "" ? "." : path)
      const visible = entries.filter((entry) => entry.name !== ".git")
      const lines = visible.slice(0, LIST_LIMIT).map((entry) => `${entry.type} ${entry.name}`)
      if (visible.length > LIST_LIMIT) lines.push(`[${visible.length - LIST_LIMIT} more entries]`)
      return lines.length === 0 ? "(empty directory)" : lines.join("\n")
    })

  const readFile = (
    path: string,
    options?: { readonly offset?: number | undefined; readonly limit?: number | undefined },
  ) =>
    Effect.gen(function* () {
      const text = yield* sandbox.readFile(path)
      const lines = text.split("\n")
      const offset = Math.max(1, Math.floor(options?.offset ?? 1))
      const limit = Math.min(
        READ_LINE_LIMIT,
        Math.max(1, Math.floor(options?.limit ?? READ_LINE_LIMIT)),
      )
      const slice = lines.slice(offset - 1, offset - 1 + limit)
      const numbered = slice.map((line, index) => `${offset + index}: ${line}`).join("\n")
      const remaining = lines.length - (offset - 1 + slice.length)
      return bounded(
        remaining > 0
          ? `${numbered}\n[${remaining} more lines; read from offset ${offset + slice.length}]`
          : numbered,
        READ_CHAR_LIMIT,
      )
    })

  const search = (pattern: string, path?: string) =>
    Effect.gen(function* () {
      const result = yield* sandbox.exec(
        "rg",
        [
          "-n",
          "--no-heading",
          "--max-count",
          "5",
          "--max-columns",
          "240",
          "--glob",
          "!.git",
          "-e",
          pattern,
          "--",
          path === undefined || path === "" ? "." : path,
        ],
        { timeout: 60_000, maxRetainedBytes: 32_000 },
      )
      if (result.exitCode === 1) return "(no matches)"
      if (!result.success) return yield* Effect.fail(`search failed: ${result.stderr.trim()}`)
      return bounded(result.stdout, SEARCH_CHAR_LIMIT)
    })

  const execute = (request: ExecutionRequest) =>
    Effect.gen(function* () {
      const endsAt = (yield* Clock.currentTimeMillis) + request.timeout
      const budget = Effect.gen(function* () {
        const left = endsAt - (yield* Clock.currentTimeMillis)
        return left > 0 ? left : yield* Effect.fail("Execution deadline exhausted.")
      })
      const ready = yield* status
      if (ready._tag !== "Ready")
        return yield* Effect.fail("Workspace lost; start a new invocation.")
      if (!/^[a-f0-9]{40}$/.test(request.commitSha))
        return yield* Effect.fail("Invalid test revision.")
      // Discard tracked edits before every command and restore the exact proposed tests.
      const head = yield* git(["rev-parse", "HEAD"])
      if (head !== request.commitSha) {
        yield* git(
          ["fetch", "-q", "--depth", "1", request.remoteUrl, request.commitSha],
          yield* budget,
        )
      }
      yield* git(["reset", "--hard", request.commitSha])
      // Keep ignored installed dependencies, remove earlier untracked proposals.
      yield* git(["clean", "-fd"])
      for (const file of request.patch?.files ?? [])
        yield* sandbox.writeFile(file.path, file.content)
      const result = yield* sandbox
        .exec(request.command, [], {
          timeout: yield* budget,
          maxRetainedBytes: 8000,
          env: { CI: "true", GIT_TERMINAL_PROMPT: "0" },
        })
        .pipe(Effect.result)
      let integrity = (yield* git(["rev-parse", "HEAD"])) === request.commitSha
      const changed = (yield* git(["diff", "--name-only", request.commitSha, "--"]))
        .split("\n")
        .filter(Boolean)
      const untracked = (yield* git(["ls-files", "--others", "--exclude-standard"]))
        .split("\n")
        .filter(Boolean)
      const paths = new Set(request.patch?.files.map((file) => file.path) ?? [])
      if ([...changed, ...untracked].some((path) => !paths.has(path))) integrity = false
      for (const file of request.patch?.files ?? []) {
        const content = yield* sandbox.readFile(file.path).pipe(Effect.result)
        if (content._tag === "Failure" || content.success !== file.content) integrity = false
      }
      const attempt = {
        id: request.id,
        patchId: request.patch?.id ?? null,
        commitSha: request.commitSha,
        command: request.command,
        kind: request.kind,
        testPath: request.testPath,
        exitCode: result._tag === "Success" ? result.success.exitCode : null,
        output:
          result._tag === "Success"
            ? (result.success.stdout + "\n" + result.success.stderr).slice(-16000)
            : String(result.failure).slice(0, 16000),
        truncated:
          result._tag === "Success" &&
          (result.success.stdoutTruncated || result.success.stderrTruncated),
        integrity,
        limitation:
          result._tag === "Failure"
            ? "Execution failed or timed out; reproduction is inconclusive."
            : !integrity
              ? "The command changed files outside the validated patch or altered the proposed tests."
              : null,
      } satisfies TestAttempt
      // Subsequent code inspection always sees the recorded default revision.
      if (request.commitSha !== ready.commitSha) {
        yield* git(["reset", "--hard", ready.commitSha])
        for (const file of request.patch?.files ?? [])
          yield* sandbox.writeFile(file.path, file.content)
      }
      return attempt
    }).pipe(Effect.raceFirst(Deferred.await(stopped)))

  const release = Deferred.fail(stopped, "Review workspace released.").pipe(Effect.andThen(wipe))
  return { provision, status, listFiles, readFile, search, execute, release }
}
