import { Context, Layer } from "effect"
import { ProtocolError } from "../Protocol.ts"

export const WORKSPACE_FORMAT = 1
export const MAX_FILE_BYTES = 1024 * 1024
export const MAX_WORKSPACE_FILES = 20000
export interface RepositoryFile {
  readonly path: string
  readonly sha: string
  readonly mode: string
  readonly type: "blob" | "commit"
  readonly size?: number
}
export interface WorkspaceState {
  readonly format: number
  readonly repositoryId: string
  readonly generation: number
  readonly commit: string | null
  readonly tree: string | null
  readonly branch: string
  readonly revision: number
}
export type FileEntry = {
  path: string
  base_sha: string | null
  work_sha: string | null
  mode: string
  type: string
  size: number
  dirty: number
  deleted: number
}

/** Paths are repository-relative. Git metadata and parent traversal are never workspace files. */
export const repositoryPath = (input: string, directory = false): string => {
  const prefix = "/workspace/repository"
  const relative =
    input === prefix ? "" : input.startsWith(prefix + "/") ? input.slice(prefix.length + 1) : input
  if (relative.startsWith("/") || relative.includes("\\") || relative.includes("\0"))
    throw new ProtocolError("invalid_request", "Path must be inside the repository")
  const parts = relative.split("/").filter((part) => part !== "" && part !== ".")
  if (parts.some((part) => part === ".." || part.toLowerCase() === ".git"))
    throw new ProtocolError(
      "invalid_request",
      "Repository traversal and Git metadata access are unavailable",
    )
  const result = parts.join("/")
  if ((!directory && !result) || result.length > 4096)
    throw new ProtocolError("invalid_request", "Invalid repository path")
  return result
}

export const gitBlobSha = async (bytes: Uint8Array): Promise<string> => {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`)
  const body = new Uint8Array(header.length + bytes.length)
  body.set(header)
  body.set(bytes, header.length)
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-1", body)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")
}

const make = (storage: DurableObjectStorage) => {
  const sql = storage.sql
  sql.exec(`CREATE TABLE IF NOT EXISTS _janitor_sql_workspace (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS _janitor_workspace_file (path TEXT PRIMARY KEY, base_sha TEXT, work_sha TEXT, mode TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, dirty INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS _janitor_workspace_blob (sha TEXT PRIMARY KEY, bytes BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS _janitor_workspace_receipt (id TEXT PRIMARY KEY, identity TEXT NOT NULL, result TEXT NOT NULL);`)
  const state = (): WorkspaceState | undefined => {
    const row = sql
      .exec<{ state: string }>("SELECT state FROM _janitor_sql_workspace WHERE id=1")
      .toArray()[0]
    return row ? JSON.parse(row.state) : undefined
  }
  const setState = (value: WorkspaceState) =>
    sql.exec("INSERT OR REPLACE INTO _janitor_sql_workspace VALUES (1, ?)", JSON.stringify(value))
  const files = (): FileEntry[] =>
    sql.exec<FileEntry>("SELECT * FROM _janitor_workspace_file ORDER BY path").toArray()
  const file = (path: string): FileEntry | undefined =>
    sql.exec<FileEntry>("SELECT * FROM _janitor_workspace_file WHERE path=?", path).toArray()[0]
  const receipt = (id: string, identity: string): string | undefined => {
    const row = sql
      .exec<{ identity: string; result: string }>(
        "SELECT identity,result FROM _janitor_workspace_receipt WHERE id=?",
        id,
      )
      .toArray()[0]
    if (row && row.identity !== identity)
      throw new ProtocolError("blocked", "Tool identity changed after its result was committed")
    return row?.result
  }
  return {
    state,
    files,
    file,
    receipt,
    matching: (pattern: string, limit = 500) =>
      sql
        .exec<FileEntry>(
          "SELECT * FROM _janitor_workspace_file WHERE deleted=0 AND (path GLOB ? OR path GLOB ?) ORDER BY path LIMIT ?",
          pattern,
          pattern.startsWith("**/") ? pattern.slice(3) : pattern,
          limit,
        )
        .toArray(),
    blob: (sha: string): Uint8Array | undefined => {
      const row = sql
        .exec<{ bytes: ArrayBuffer }>("SELECT bytes FROM _janitor_workspace_blob WHERE sha=?", sha)
        .toArray()[0]
      return row ? new Uint8Array(row.bytes) : undefined
    },
    cache: (sha: string, bytes: Uint8Array) => {
      if (bytes.length > MAX_FILE_BYTES)
        throw new ProtocolError("blocked", "File exceeds the 1 MiB workspace file limit")
      sql.exec("INSERT OR IGNORE INTO _janitor_workspace_blob VALUES (?, ?)", sha, bytes)
    },
    initialize: (
      value: Omit<WorkspaceState, "format" | "revision">,
      entries: ReadonlyArray<RepositoryFile>,
    ) => {
      if (entries.length > MAX_WORKSPACE_FILES)
        throw new ProtocolError("blocked", "Repository exceeds the 20,000-file workspace limit")
      storage.transactionSync(() => {
        sql.exec("DELETE FROM _janitor_workspace_file")
        for (const entry of entries)
          sql.exec(
            "INSERT INTO _janitor_workspace_file (path,base_sha,mode,type,size) VALUES (?,?,?,?,?)",
            repositoryPath(entry.path),
            entry.sha,
            entry.mode,
            entry.type,
            entry.size ?? 0,
          )
        setState({ ...value, format: WORKSPACE_FORMAT, revision: (state()?.revision ?? 0) + 1 })
      })
    },
    /** Local file changes and their replay receipt commit in one SQLite transaction. */
    commitTool: (
      id: string,
      identity: string,
      result: string,
      mutation?: { path: string; sha: string | null; bytes?: Uint8Array },
    ) => {
      storage.transactionSync(() => {
        if (receipt(id, identity) !== undefined) return
        if (mutation) {
          const current = state()
          if (!current) throw new ProtocolError("blocked", "Workspace is not initialized")
          const previous = file(mutation.path)
          if (previous && (previous.type !== "blob" || previous.mode === "120000"))
            throw new ProtocolError("blocked", "Editing symlinks and submodules is unavailable")
          if (!previous && files().length >= MAX_WORKSPACE_FILES)
            throw new ProtocolError("blocked", "Workspace file limit reached")
          if (mutation.bytes) {
            if (mutation.bytes.length > MAX_FILE_BYTES)
              throw new ProtocolError("blocked", "File exceeds the 1 MiB workspace file limit")
            sql.exec(
              "INSERT OR IGNORE INTO _janitor_workspace_blob VALUES (?, ?)",
              mutation.sha,
              mutation.bytes,
            )
          }
          sql.exec(
            "INSERT INTO _janitor_workspace_file (path,base_sha,work_sha,mode,type,size,dirty,deleted) VALUES (?,NULL,?,'100644','blob',?,1,?) ON CONFLICT(path) DO UPDATE SET work_sha=excluded.work_sha,size=excluded.size,dirty=1,deleted=excluded.deleted",
            mutation.path,
            mutation.sha,
            mutation.bytes?.length ?? 0,
            mutation.sha === null ? 1 : 0,
          )
          setState({ ...current, revision: current.revision + 1 })
        }
        sql.exec("INSERT INTO _janitor_workspace_receipt VALUES (?,?,?)", id, identity, result)
      })
    },
    clear: () =>
      storage.transactionSync(() => {
        for (const table of [
          "_janitor_workspace_file",
          "_janitor_workspace_blob",
          "_janitor_workspace_receipt",
          "_janitor_sql_workspace",
        ])
          sql.exec(`DELETE FROM ${table}`)
      }),
  }
}

export class WorkspaceStore extends Context.Service<WorkspaceStore, ReturnType<typeof make>>()(
  "janitor/runner/WorkspaceStore",
) {
  static make = make
  static layer(storage: DurableObjectStorage) {
    return Layer.sync(this, () => make(storage))
  }
}
