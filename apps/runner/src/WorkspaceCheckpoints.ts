import { Effect } from "effect"
import { CheckpointStore } from "./services/CheckpointStore.ts"
import { ProtocolError } from "./Protocol.ts"
import { CHECKPOINT_MANIFEST_VERSION, RELEASE_MANIFEST } from "./ReleaseManifest.ts"
import { RunnerStorage } from "./Storage.ts"

export interface Archive {
  readonly body: ReadableStream<Uint8Array>
  readonly size: number
  readonly sha256: string
}
export interface Checkpoint {
  readonly key: string
  readonly sha256: string
  readonly manifest: CheckpointManifest | null
}
/** The workspace a checkpoint belongs to; a manifest naming another one is refused. */
export interface CheckpointIdentity {
  readonly sessionId: string
  readonly generation: number
  readonly repositoryId: string
}
/**
 * Committed beside the archive pointer. Restore refuses an archive whose
 * manifest names an unsupported format, another workspace or a different
 * digest, before anything in the active workspace is replaced.
 */
export interface CheckpointManifest extends CheckpointIdentity {
  readonly manifestVersion: number
  readonly format: string
  readonly sha256: string
  /** Null on a backfilled manifest: format 1 did not record the archive size. */
  readonly size: number | null
  readonly key: string
  readonly operationId: string | null
  readonly committedAt: number
  /** True when a format 1 pointer was given its manifest by the state upgrade. */
  readonly backfilled?: boolean
}
/** The archive format the bridge currently writes. */
export const ARCHIVE_FORMAT = RELEASE_MANIFEST.checkpoint.archiveFormats[0]!
export const checksum = async (data: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("")

/** Upload intents precede R2 writes. Only the SQLite pointer makes an archive authoritative. */
export class WorkspaceCheckpoints {
  private readonly objects: CheckpointStore["Service"]
  private readonly uploading = new Set<string>()
  constructor(
    private readonly storage: DurableObjectStorage,
    bucket?: R2Bucket,
    private readonly identity?: CheckpointIdentity,
  ) {
    this.objects = CheckpointStore.make(bucket)
    storage.sql
      .exec(`CREATE TABLE IF NOT EXISTS _janitor_checkpoint (id INTEGER PRIMARY KEY, key TEXT NOT NULL, sha256 TEXT NOT NULL, manifest TEXT);
      CREATE TABLE IF NOT EXISTS _janitor_archive_upload (key TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS _janitor_tool_operation (id TEXT PRIMARY KEY, identity TEXT NOT NULL, state TEXT NOT NULL, result TEXT)`)
  }
  /** True while a format 1 pointer table lacks its manifest column. */
  static needsFormatUpgrade(storage: DurableObjectStorage): boolean {
    if (!new RunnerStorage(storage).tableExists("_janitor_checkpoint")) return false
    return !storage.sql
      .exec("PRAGMA table_info(_janitor_checkpoint)")
      .toArray()
      .some((column) => column.name === "manifest")
  }
  /**
   * The Janitor state format 1 to 2 step: the pointer gains a manifest column
   * and the existing pointer, which format 1 could only have written for this
   * workspace in the bridge's current archive format, gets its manifest.
   * Idempotent, so a restart after a partial upgrade repeats it safely.
   */
  static upgradeFormat(storage: DurableObjectStorage, identity: CheckpointIdentity | undefined) {
    if (!new RunnerStorage(storage).tableExists("_janitor_checkpoint")) return
    if (WorkspaceCheckpoints.needsFormatUpgrade(storage))
      storage.sql.exec("ALTER TABLE _janitor_checkpoint ADD COLUMN manifest TEXT")
    const row = storage.sql
      .exec<{ key: string; sha256: string; manifest: string | null }>(
        "SELECT key, sha256, manifest FROM _janitor_checkpoint WHERE id = 1",
      )
      .toArray()[0]
    if (!row || row.manifest !== null) return
    if (!identity)
      throw new ProtocolError("blocked", "Checkpoint pointer exists without a workspace identity")
    const manifest: CheckpointManifest = {
      manifestVersion: CHECKPOINT_MANIFEST_VERSION,
      format: ARCHIVE_FORMAT,
      ...identity,
      sha256: row.sha256,
      size: null,
      key: row.key,
      operationId: null,
      committedAt: Date.now(),
      backfilled: true,
    }
    storage.sql.exec(
      "UPDATE _janitor_checkpoint SET manifest = ? WHERE id = 1",
      JSON.stringify(manifest),
    )
  }
  current(): Checkpoint | undefined {
    const row = this.storage.sql
      .exec<{ key: string; sha256: string; manifest: string | null }>(
        "SELECT key, sha256, manifest FROM _janitor_checkpoint WHERE id = 1",
      )
      .toArray()[0]
    if (!row) return undefined
    let manifest: CheckpointManifest | null = null
    try {
      manifest = row.manifest === null ? null : (JSON.parse(row.manifest) as CheckpointManifest)
    } catch {
      manifest = null
    }
    return { key: row.key, sha256: row.sha256, manifest }
  }
  /** True while an archive is still streaming to R2; its pointer is not yet authoritative. */
  get settling() {
    return this.uploading.size > 0
  }
  /**
   * The reason the committed checkpoint cannot be restored by this release, or
   * null. Read-only: an incompatible pointer stays exactly as it is for repair.
   */
  validate(): string | null {
    const pointer = this.current()
    if (!pointer) return null
    const manifest = pointer.manifest
    if (manifest === null) return "committed checkpoint has no manifest; operator repair required"
    if (manifest.manifestVersion !== CHECKPOINT_MANIFEST_VERSION)
      return `checkpoint manifest version ${manifest.manifestVersion} is not supported by this release`
    if (!RELEASE_MANIFEST.checkpoint.archiveFormats.includes(manifest.format))
      return `checkpoint archive format ${manifest.format} is not supported by this release`
    if (manifest.sha256 !== pointer.sha256 || manifest.key !== pointer.key)
      return "checkpoint manifest disagrees with its pointer; operator repair required"
    if (
      this.identity &&
      (manifest.sessionId !== this.identity.sessionId ||
        manifest.generation !== this.identity.generation ||
        manifest.repositoryId !== this.identity.repositoryId)
    )
      return `checkpoint belongs to session ${manifest.sessionId} generation ${manifest.generation} repository ${manifest.repositoryId}, not this workspace`
    return null
  }
  uncertain() {
    return (
      this.storage.sql
        .exec("SELECT id FROM _janitor_tool_operation WHERE state = 'admitted' LIMIT 1")
        .toArray().length > 0
    )
  }
  async admit(id: string, input: unknown): Promise<string | undefined> {
    if (!this.objects.available)
      throw new ProtocolError("blocked", "Workspace checkpoint bucket is not configured")
    const identity = await checksum(JSON.stringify(input))
    const prior = this.storage.sql
      .exec<{ identity: string; state: string; result: string }>(
        "SELECT * FROM _janitor_tool_operation WHERE id = ?",
        id,
      )
      .toArray()[0]
    if (prior) {
      if (prior.identity !== identity || prior.state !== "complete")
        throw new ProtocolError("blocked", "Tool operation is uncertain; replay refused")
      return prior.result
    }
    if (this.uncertain())
      throw new ProtocolError("blocked", "Earlier tool operation requires reconciliation")
    this.storage.sql.exec(
      "INSERT INTO _janitor_tool_operation VALUES (?, ?, 'admitted', NULL)",
      id,
      identity,
    )
    await this.storage.sync()
  }
  async commit(archive: Archive, resource: string, operation?: { id: string; result: string }) {
    if (!this.objects.available)
      throw new ProtocolError("blocked", "Workspace checkpoint bucket is not configured")
    const key = `${resource}/${crypto.randomUUID()}.ndjson`
    this.uploading.add(key)
    try {
      this.storage.sql.exec("INSERT INTO _janitor_archive_upload VALUES (?)", key)
      await this.storage.sync()
      await Effect.runPromise(this.objects.upload(key, archive))
    } finally {
      this.uploading.delete(key)
    }
    const identity = this.identity
    if (!identity)
      throw new ProtocolError("blocked", "Checkpoints require a workspace identity to commit")
    const manifest: CheckpointManifest = {
      manifestVersion: CHECKPOINT_MANIFEST_VERSION,
      format: ARCHIVE_FORMAT,
      ...identity,
      sha256: archive.sha256,
      size: archive.size,
      key,
      operationId: operation?.id ?? null,
      committedAt: Date.now(),
    }
    this.storage.transactionSync(() => {
      if (new RunnerStorage(this.storage).disconnection !== undefined)
        throw new ProtocolError("stale_generation", "Late checkpoint completion fenced")
      this.storage.sql.exec(
        "INSERT OR REPLACE INTO _janitor_checkpoint (id, key, sha256, manifest) VALUES (1, ?, ?, ?)",
        key,
        archive.sha256,
        JSON.stringify(manifest),
      )
      if (operation)
        this.storage.sql.exec(
          "UPDATE _janitor_tool_operation SET state = 'complete', result = ? WHERE id = ?",
          operation.result,
          operation.id,
        )
    })
    await this.storage.sync()
  }
  async restore(): Promise<Archive | undefined> {
    const pointer = this.current()
    if (!pointer) return
    const problem = this.validate()
    if (problem !== null) throw new ProtocolError("blocked", problem)
    return Effect.runPromise(this.objects.read(pointer.key, pointer.sha256))
  }
  async prune(all = false) {
    if (all && this.uploading.size > 0)
      throw new ProtocolError("blocked", "Workspace upload is still settling; retry cleanup")
    for (const { key } of this.storage.sql
      .exec<{ key: string }>("SELECT key FROM _janitor_archive_upload")
      .toArray()) {
      if ((!all && key === this.current()?.key) || this.uploading.has(key)) continue
      if (!this.objects.available)
        throw new ProtocolError("blocked", "Workspace checkpoint bucket is not configured")
      await Effect.runPromise(this.objects.remove(key))
      this.storage.sql.exec("DELETE FROM _janitor_archive_upload WHERE key = ?", key)
    }
    await this.storage.sync()
  }
}
