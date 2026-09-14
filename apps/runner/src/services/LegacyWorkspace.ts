import { createHash } from "node:crypto"
import { Context, Layer } from "effect"
import { ProtocolError } from "../Protocol.ts"
import { RunnerStorage } from "../Storage.ts"
import {
  gitBlobSha,
  MAX_FILE_BYTES,
  MAX_WORKSPACE_FILES,
  repositoryPath,
  WorkspaceStore,
} from "./WorkspaceStore.ts"
import type { RepositorySelection } from "../RepositoryWorkspace.ts"

const blocked = (message: string): never => {
  throw new ProtocolError(
    "blocked",
    `Legacy workspace: ${message}. The original archive is preserved.`,
  )
}
const make = (
  storage: DurableObjectStorage,
  bucket: R2Bucket | undefined,
  selected: RepositorySelection,
) => {
  const store = new RunnerStorage(storage)
  const uncertain = () =>
    ["_janitor_tool_operation", "_janitor_operation"].some(
      (table) =>
        store.tableExists(table) &&
        storage.sql.exec(`SELECT id FROM ${table} WHERE state='admitted' LIMIT 1`).toArray()
          .length > 0,
    )
  const pointer = () =>
    store.tableExists("_janitor_checkpoint")
      ? storage.sql
          .exec<{ key: string; sha256: string }>(
            "SELECT key,sha256 FROM _janitor_checkpoint WHERE id=1",
          )
          .toArray()[0]
      : undefined
  return {
    uncertain,
    present: () => pointer() !== undefined,
    destroy: async () => {
      const keys = new Set<string>()
      const saved = pointer()
      if (saved) keys.add(saved.key)
      if (store.tableExists("_janitor_archive_upload"))
        for (const row of storage.sql.exec<{ key: string }>(
          "SELECT key FROM _janitor_archive_upload",
        ))
          keys.add(row.key)
      if (keys.size && !bucket) blocked("checkpoint bucket binding is missing during cleanup")
      for (const key of keys) await bucket!.delete(key)
    },
    /** Import only a confirmed archive. Never rerun a legacy process with an unknown outcome. */
    read: async (files: WorkspaceStore["Service"], branch: string) => {
      const saved = pointer()
      if (!saved) return undefined
      if (uncertain())
        blocked(
          "an operation has an unknown outcome; reconcile it with the previous release before migration",
        )
      if (!bucket) blocked("checkpoint bucket binding is missing")
      const columns = storage.sql.exec("PRAGMA table_info(_janitor_checkpoint)").toArray()
      if (columns.some((column) => column.name === "manifest")) {
        const row = storage.sql
          .exec<{ manifest: string | null }>("SELECT manifest FROM _janitor_checkpoint WHERE id=1")
          .toArray()[0]
        if (row?.manifest) {
          const manifest = JSON.parse(row.manifest)
          if (
            manifest.manifestVersion !== 1 ||
            manifest.format !== "janitor-workspace-2" ||
            manifest.sha256 !== saved.sha256 ||
            manifest.key !== saved.key ||
            manifest.sessionId !== selected.sessionId ||
            manifest.generation !== selected.generation ||
            manifest.repositoryId !== selected.repositoryId
          )
            blocked("checkpoint identity or format is incompatible")
        }
      }
      const archive = await bucket!.get(saved.key)
      if (!archive) blocked("checkpoint archive is missing")
      const hash = createHash("sha256")
      const decoder = new TextDecoder("utf-8", { fatal: true })
      let buffer = "",
        format = false,
        active:
          | { path: string; mode: string; parts: Uint8Array[]; size: number; keep: boolean }
          | undefined
      const entries = new Map<string, { sha: string; mode: string; size: number }>()
      const refs = new Map<string, string>()
      const finish = async () => {
        if (!active) blocked("archive contains an unexpected file terminator")
        const current = active!
        active = undefined
        if (!current.keep) return
        const bytes = new Uint8Array(current.size)
        let offset = 0
        for (const part of current.parts) {
          bytes.set(part, offset)
          offset += part.length
        }
        if (current.path.startsWith("repository/.git/")) {
          refs.set(current.path.slice(16), new TextDecoder().decode(bytes))
          return
        }
        const path = repositoryPath(current.path.slice(11))
        if (entries.has(path)) blocked("archive has duplicate paths")
        const sha = await gitBlobSha(bytes)
        files.cache(sha, bytes)
        entries.set(path, { sha, mode: current.mode, size: bytes.length })
        if (entries.size > MAX_WORKSPACE_FILES) blocked("archive exceeds the workspace file limit")
      }
      const record = async (line: string) => {
        if (line.length > 100000) blocked("archive record exceeds its chunk limit")
        const row = JSON.parse(line)
        if (!format) {
          if (row.format !== "janitor-workspace-2") blocked("unsupported archive format")
          format = true
          return
        }
        if (row.end === true) {
          await finish()
          return
        }
        if (typeof row.data === "string") {
          if (!active) blocked("archive data has no file")
          if (active!.keep) {
            const bytes = Uint8Array.from(atob(row.data), (char) => char.charCodeAt(0))
            active!.size += bytes.length
            if (active!.size > MAX_FILE_BYTES) blocked("a file exceeds the 1 MiB workspace limit")
            active!.parts.push(bytes)
          }
          return
        }
        if (active) blocked("archive file is incomplete")
        if (
          typeof row.path !== "string" ||
          row.path.split("/").some((part: string) => part === "..")
        )
          blocked("invalid archive path")
        if (row.type === "directory") return
        const metadata = row.path.startsWith("repository/.git/")
        const keep = metadata
          ? row.path === "repository/.git/packed-refs" ||
            row.path.startsWith("repository/.git/refs/remotes/origin/")
          : row.path.startsWith("repository/")
        if (row.type === "symlink") {
          if (keep && !metadata) {
            const path = repositoryPath(row.path.slice(11)),
              bytes = new TextEncoder().encode(row.target)
            const sha = await gitBlobSha(bytes)
            files.cache(sha, bytes)
            entries.set(path, { sha, mode: "120000", size: bytes.length })
          }
          return
        }
        if (row.type !== "file") blocked("unsupported archive entry")
        active = {
          path: row.path,
          mode: row.mode & 0o111 ? "100755" : "100644",
          parts: [],
          size: 0,
          keep,
        }
      }
      const reader = archive!.body.getReader()
      try {
        for (;;) {
          const next = await reader.read()
          if (next.done) break
          hash.update(next.value)
          buffer += decoder.decode(next.value, { stream: true })
          let newline: number
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline)
            buffer = buffer.slice(newline + 1)
            await record(line)
          }
          if (buffer.length > 100000) blocked("archive record exceeds its chunk limit")
        }
        buffer += decoder.decode()
        if (buffer || active || !format || hash.digest("hex") !== saved.sha256)
          blocked("archive checksum or framing is invalid")
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
      const name = `refs/remotes/origin/${branch}`
      const packed = refs
        .get("packed-refs")
        ?.split("\n")
        .find((line) => line.endsWith(` ${name}`))
        ?.split(" ")[0]
      const commit = refs.get(name)?.trim() ?? packed
      if (!commit || !/^[a-f0-9]{40}$/.test(commit))
        blocked(
          "the archived remote branch cannot be identified; recover the archive with the previous release",
        )
      return { commit: commit!, entries }
    },
  }
}
export class LegacyWorkspace extends Context.Service<LegacyWorkspace, ReturnType<typeof make>>()(
  "janitor/runner/LegacyWorkspace",
) {
  static make = make
  static layer(
    storage: DurableObjectStorage,
    bucket: R2Bucket | undefined,
    selected: RepositorySelection,
  ) {
    return Layer.sync(this, () => make(storage, bucket, selected))
  }
}
