import { LegacyWorkspace } from "./services/LegacyWorkspace.ts"
import { Effect } from "effect"
import { WorkspaceDriver } from "@opencode/core/workspace/driver"
import {
  Failed,
  NotFound,
  makeMemoryDriver,
  type DirEntry,
  type FilesImpl,
} from "@opencode/core/environment/index"
import { ProtocolError } from "./Protocol.ts"
import { RunnerStorage } from "./Storage.ts"
import { Publication, type CredentialPermission } from "./Publication.ts"
import { checksum } from "./Hash.ts"
import { RepositoryAuthority as CredentialAuthority } from "./services/RepositoryAuthority.ts"
import { GitHubRepository } from "./services/GitHubRepository.ts"
import { WorkspacePublication } from "./services/WorkspacePublication.ts"
import {
  WorkspaceStore,
  WORKSPACE_FORMAT,
  gitBlobSha,
  repositoryPath,
} from "./services/WorkspaceStore.ts"

export const REPOSITORY_TOOLS: ReadonlyArray<string> = [
  "read",
  "glob",
  "grep",
  "edit",
  "write",
  "delete",
  "diff",
  "publish",
]
export interface RepositorySelection {
  readonly sessionId: string
  readonly generation: number
  readonly repositoryId: string
}
export interface RepositoryAuthority {
  readonly fetch: (request: Request) => Promise<Response>
}
export interface WorkspaceEnvironment {
  readonly REPOSITORY_AUTHORITY?: RepositoryAuthority
  readonly REPOSITORY_SERVICE_TOKEN?: string
  /** Native HTTP fixture in local/test Workers; production uses GitHub directly. */
  readonly GITHUB_API?: RepositoryAuthority
  /** Read only during migration of pre-SQLite workspaces. */
  readonly WORKSPACE_CHECKPOINTS?: R2Bucket
}
export interface WorkspaceToolInput {
  path?: string
  content?: string
  oldText?: string
  newText?: string
  replaceAll?: boolean
  pattern?: string
  offset?: number
  limit?: number
}

/** Coordinates one durable workspace; local mutations never leave the session's SQLite database. */
export class RepositoryWorkspace {
  readonly files: WorkspaceStore["Service"]
  readonly publication: Publication
  readonly github: GitHubRepository["Service"]
  private readonly legacy: LegacyWorkspace["Service"]
  private readonly credentials: CredentialAuthority["Service"]
  private connecting: Promise<void> | undefined
  private active = 0
  get busy() {
    return this.active > 0
  }
  get uncertain() {
    return this.legacy.uncertain()
  }
  get currentToolTimeout() {
    return this.busy ? 120000 : undefined
  }

  constructor(
    private readonly storage: DurableObjectStorage,
    env: WorkspaceEnvironment,
    readonly selected: RepositorySelection,
  ) {
    this.files = WorkspaceStore.make(storage)
    this.legacy = LegacyWorkspace.make(storage, env.WORKSPACE_CHECKPOINTS, selected)
    this.credentials = CredentialAuthority.make(
      env.REPOSITORY_AUTHORITY,
      env.REPOSITORY_SERVICE_TOKEN,
    )
    this.github = GitHubRepository.make(
      (request) => env.GITHUB_API?.fetch(request) ?? fetch(request),
      () => this.fence(),
    )
    const git = WorkspacePublication.make({
      storage,
      files: this.files,
      github: this.github,
      authorize: (permission) => this.authority(true, permission, true),
      fence: () => this.fence(),
    })
    this.publication = new Publication(storage, selected, {
      authorize: (token, permission, refresh) => this.authority(token, permission, true, refresh),
      fetch: (request) => env.GITHUB_API?.fetch(request) ?? fetch(request),
      fence: () => this.fence(),
      git: <A>(action: string, input: unknown) =>
        Effect.runPromise(git.execute(action, input)) as Promise<A>,
      checkpoint: () => storage.sync(),
    })
  }
  private authority(
    token: boolean,
    permission: CredentialPermission = "read",
    publication = false,
    refresh = false,
  ) {
    return Effect.runPromise(
      this.credentials.authorize({ ...this.selected, token, permission, publication, refresh }),
    )
  }
  private async fence() {
    if (new RunnerStorage(this.storage).disconnection)
      throw new ProtocolError("stale_generation", "Workspace was disconnected")
    const state = this.files.state()
    if (
      state &&
      (state.repositoryId !== this.selected.repositoryId ||
        state.generation !== this.selected.generation)
    )
      throw new ProtocolError("stale_generation", "Workspace selection changed")
  }
  connect(): Promise<void> {
    return (this.connecting ??= this.open().finally(() => {
      this.connecting = undefined
    }))
  }
  private async open() {
    await this.fence()
    await this.authority(false)
    const state = this.files.state()
    if (state) {
      if (state.format !== WORKSPACE_FORMAT)
        throw new ProtocolError("blocked", "Workspace format is not supported")
      return
    }
    const credential = await this.authority(true)
    const metadata = await Effect.runPromise(this.github.metadata(credential))
    if (String(metadata.id) !== this.selected.repositoryId)
      throw new ProtocolError("blocked", "GitHub repository identity changed")
    const association = await this.publication.workspace()
    const branch = association?.branch ?? metadata.default_branch
    const legacy = await this.legacy.read(this.files, branch)
    const commit =
      legacy?.commit ??
      association?.headCommit ??
      (await Effect.runPromise(this.github.ref(credential, branch)))
    const head = commit
      ? await Effect.runPromise(this.github.commit(credential, commit))
      : undefined
    const entries = head ? await Effect.runPromise(this.github.tree(credential, head.tree.sha)) : []
    await this.fence()
    this.storage.transactionSync(() => {
      this.files.initialize(
        {
          repositoryId: this.selected.repositoryId,
          generation: this.selected.generation,
          commit,
          tree: head?.tree.sha ?? null,
          branch,
        },
        entries,
      )
      if (legacy) {
        const original = new Map(entries.map((entry) => [entry.path, entry]))
        for (const [path, file] of legacy.entries) {
          if (original.get(path)?.sha === file.sha && original.get(path)?.mode === file.mode)
            continue
          this.storage.sql.exec(
            "INSERT INTO _janitor_workspace_file (path,base_sha,work_sha,mode,type,size,dirty,deleted) VALUES (?,?,?,?, 'blob',?,1,0) ON CONFLICT(path) DO UPDATE SET work_sha=excluded.work_sha,mode=excluded.mode,size=excluded.size,dirty=1,deleted=0",
            path,
            original.get(path)?.sha ?? null,
            file.sha,
            file.mode,
            file.size,
          )
        }
        for (const entry of entries)
          if (entry.type === "blob" && !legacy.entries.has(entry.path))
            this.storage.sql.exec(
              "UPDATE _janitor_workspace_file SET dirty=1,deleted=1 WHERE path=?",
              entry.path,
            )
      }
    })
    await this.storage.sync()
  }
  private async bytes(path: string, base = false): Promise<Uint8Array> {
    const file = this.files.file(path)
    if (!file || (!base && file.deleted))
      throw new ProtocolError("invalid_request", `Repository file ${path} was not found`)
    if (file.type !== "blob" || file.mode === "120000")
      throw new ProtocolError("blocked", "Symlink and submodule contents are not followed")
    const sha = base ? file.base_sha : file.dirty ? file.work_sha : file.base_sha
    if (!sha) return new Uint8Array()
    const cached = this.files.blob(sha)
    if (cached) return cached
    const bytes = await Effect.runPromise(this.github.blob(await this.authority(true), sha))
    await this.fence()
    this.files.cache(sha, bytes)
    return bytes
  }
  private async text(path: string, base = false) {
    const bytes = await this.bytes(path, base)
    if (bytes.includes(0))
      throw new ProtocolError("blocked", "Binary file content is not a text tool input")
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    } catch {
      throw new ProtocolError("blocked", "File is not UTF-8 text")
    }
  }
  /** The returned text and any mutation are committed with the stable native tool identity. */
  async tool(id: string, name: string, input: WorkspaceToolInput): Promise<{ content: string }> {
    if (new RunnerStorage(this.storage).maintenance.held) await new Promise<never>(() => {})
    this.active++
    try {
      await this.fence()
      await this.authority(false)
      const identity = await checksum(JSON.stringify({ name, input }))
      const prior = this.files.receipt(id, identity)
      if (prior !== undefined) return JSON.parse(prior)
      await this.publication.guard()
      let content: string
      let mutation: { path: string; sha: string | null; bytes?: Uint8Array } | undefined
      if (["read", "write", "edit", "delete"].includes(name)) {
        const path = repositoryPath(input.path ?? "")
        if (name === "read") {
          const text = await this.text(path)
          const offset = input.offset ?? 0,
            limit = Math.min(input.limit ?? 16000, 64000)
          if (
            !Number.isSafeInteger(offset) ||
            offset < 0 ||
            !Number.isSafeInteger(limit) ||
            limit < 1
          )
            throw new ProtocolError(
              "invalid_request",
              "Read offset must be nonnegative and limit must be positive",
            )
          content =
            text.slice(offset, offset + limit) +
            (offset + limit < text.length ? "\n[Truncated; use offset to read more.]" : "")
        } else if (name === "delete") {
          if (!this.files.file(path) || this.files.file(path)!.deleted)
            throw new ProtocolError("invalid_request", "Cannot delete a missing file")
          mutation = { path, sha: null }
          content = `Deleted ${path}`
        } else {
          let text = input.content ?? ""
          if (name === "edit") {
            if (!input.oldText)
              throw new ProtocolError("invalid_request", "An edit requires nonempty oldText")
            const previous = await this.text(path)
            const parts = previous.split(input.oldText)
            if (parts.length === 1 || (!input.replaceAll && parts.length !== 2))
              throw new ProtocolError(
                "blocked",
                "Edit text must match exactly once; read the current file before retrying",
              )
            text = parts.join(input.newText ?? "")
          }
          const bytes = new TextEncoder().encode(text)
          mutation = { path, bytes, sha: await gitBlobSha(bytes) }
          content = `${name === "edit" ? "Edited" : "Wrote"} ${path}`
        }
      } else if (name === "glob") {
        const pattern = input.pattern ?? "*"
        if (pattern.length > 512 || pattern.includes(".."))
          throw new ProtocolError("invalid_request", "Invalid file pattern")
        const prefix = repositoryPath(input.path ?? ".", true)
        const matches = this.files.matching(prefix ? `${prefix}/${pattern}` : pattern, 501)
        content =
          matches
            .slice(0, 500)
            .map((file) => file.path)
            .join("\n") + (matches.length > 500 ? "\n[Truncated; narrow the pattern.]" : "")
      } else if (name === "grep") {
        if (!input.pattern || input.pattern.length > 1000)
          throw new ProtocolError("invalid_request", "Search requires a bounded literal pattern")
        const path = repositoryPath(input.path ?? ".", true)
        const candidates = this.files.file(path)
          ? [this.files.file(path)!]
          : this.files.matching(path ? `${path}/*` : "*", 501)
        const matches: string[] = []
        let searched = 0,
          bytes = 0
        for (const file of candidates) {
          if (file.deleted || file.mode === "120000" || file.type !== "blob") continue
          if (searched >= 500 || bytes + file.size > 8 * 1024 * 1024 || matches.length >= 100) break
          const text = await this.text(file.path).catch((error) => {
            if (
              error instanceof ProtocolError &&
              ["Binary file content is not a text tool input", "File is not UTF-8 text"].includes(
                error.message,
              )
            )
              return ""
            throw error
          })
          searched++
          bytes += text.length
          for (const [index, line] of text.split("\n").entries())
            if (line.includes(input.pattern)) {
              matches.push(`${file.path}:${index + 1}: ${line.slice(0, 1000)}`)
              if (matches.length >= 100) break
            }
        }
        content =
          matches.join("\n") +
          `\nSearched ${searched} files; ${searched < candidates.length || matches.length >= 100 ? "results are bounded, narrow the path to continue" : "search complete"}.`
      } else if (name === "diff") {
        const changes: string[] = []
        for (const file of this.files.files().filter((entry) => entry.dirty)) {
          const before = file.base_sha ? await this.text(file.path, true) : ""
          const after = file.deleted ? "" : await this.text(file.path)
          if (before === after) continue
          changes.push(
            `--- a/${file.path}\n+++ b/${file.path}\n${before
              .split("\n")
              .map((line) => "-" + line)
              .join("\n")}\n${after
              .split("\n")
              .map((line) => "+" + line)
              .join("\n")}`,
          )
          if (changes.join("\n").length > 64000) break
        }
        const result = changes.join("\n")
        content =
          result.slice(0, 64000) + (result.length > 64000 ? "\n[Diff truncated.]" : "") ||
          "No local changes."
      } else
        throw new ProtocolError(
          "invalid_request",
          "This workspace has no shell or executable repository tools",
        )
      await this.fence()
      const result = { content }
      this.files.commitTool(id, identity, JSON.stringify(result), mutation)
      await this.storage.sync()
      return result
    } finally {
      this.active--
    }
  }
  async publish<A>(run: () => Promise<A>): Promise<A> {
    if (new RunnerStorage(this.storage).maintenance.held) await new Promise<never>(() => {})
    this.active++
    try {
      await this.fence()
      return await run()
    } finally {
      this.active--
    }
  }
  async destroy() {
    await this.legacy.destroy()
    this.files.clear()
    await this.storage.sync()
  }
  driver() {
    const attempt = <A>(path: string, operation: () => Promise<A>) =>
      Effect.tryPromise({ try: operation, catch: (cause) => new Failed({ path, cause }) })
    const files: FilesImpl = {
      read: (path, range) =>
        attempt(path, async () => {
          const bytes = await this.bytes(repositoryPath(path))
          return {
            info: { type: "file", size: bytes.length, mtimeMs: 0 },
            bytes: range ? bytes.slice(range.offset, range.offset + range.length) : bytes,
          }
        }),
      stat: (path) =>
        Effect.suspend((): ReturnType<FilesImpl["stat"]> => {
          const relative = repositoryPath(path, true),
            file = this.files.file(relative)
          if (file && !file.deleted)
            return Effect.succeed({
              type: file.mode === "120000" ? ("symlink" as const) : ("file" as const),
              size: file.size,
              mtimeMs: 0,
            })
          if (
            !relative ||
            this.files.files().some((file) => !file.deleted && file.path.startsWith(relative + "/"))
          )
            return Effect.succeed({ type: "directory" as const, size: 0, mtimeMs: 0 })
          return Effect.fail(new NotFound({ path }))
        }),
      list: (path) =>
        Effect.sync(() => {
          const relative = repositoryPath(path, true),
            prefix = relative ? relative + "/" : "",
            entries = new Map<string, DirEntry>()
          for (const file of this.files.files())
            if (!file.deleted && file.path.startsWith(prefix)) {
              const rest = file.path.slice(prefix.length),
                name = rest.split("/")[0]!
              entries.set(name, {
                name,
                type: rest.includes("/")
                  ? "directory"
                  : file.mode === "120000"
                    ? "symlink"
                    : "file",
              })
            }
          return [...entries.values()]
        }),
      write: (path) =>
        Effect.fail(new Failed({ path, cause: "Use an admitted workspace tool to change files" })),
      remove: (path) => Effect.fail(new Failed({ path, cause: "Use the delete tool" })),
      move: (path) =>
        Effect.fail(new Failed({ path, cause: "Use admitted read/write/delete tools" })),
      mkdir: (path) =>
        Effect.sync(() => {
          repositoryPath(path, true)
        }),
    }
    return WorkspaceDriver.make({
      create: () => Effect.succeed({ binding: { repositoryId: this.selected.repositoryId } }),
      connect: () => Effect.succeed({ ...makeMemoryDriver(), overrides: files }),
      suspendForIdle: () => Effect.void,
      destroy: () => Effect.promise(() => this.destroy()),
    })
  }
}
