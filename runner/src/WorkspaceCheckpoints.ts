import { ProtocolError } from "./Protocol.ts"
import { RunnerStorage } from "./Storage.ts"

export interface Archive {
  readonly body: ReadableStream<Uint8Array>
  readonly size: number
  readonly sha256: string
}
export interface Checkpoint {
  readonly key: string
  readonly sha256: string
}
export const checksum = async (data: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("")

/** Upload intents precede R2 writes. Only the SQLite pointer makes an archive authoritative. */
export class WorkspaceCheckpoints {
  private readonly uploading = new Set<string>()
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly bucket?: R2Bucket,
  ) {
    storage.sql
      .exec(`CREATE TABLE IF NOT EXISTS _janitor_checkpoint (id INTEGER PRIMARY KEY, key TEXT NOT NULL, sha256 TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS _janitor_archive_upload (key TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS _janitor_tool_operation (id TEXT PRIMARY KEY, identity TEXT NOT NULL, state TEXT NOT NULL, result TEXT)`)
  }
  current(): Checkpoint | undefined {
    return this.storage.sql
      .exec<Checkpoint & Record<string, SqlStorageValue>>(
        "SELECT key, sha256 FROM _janitor_checkpoint WHERE id = 1",
      )
      .toArray()[0]
  }
  uncertain() {
    return (
      this.storage.sql
        .exec("SELECT id FROM _janitor_tool_operation WHERE state = 'admitted' LIMIT 1")
        .toArray().length > 0
    )
  }
  async admit(id: string, input: unknown): Promise<string | undefined> {
    if (!this.bucket)
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
    if (!this.bucket)
      throw new ProtocolError("blocked", "Workspace checkpoint bucket is not configured")
    const key = `${resource}/${crypto.randomUUID()}.ndjson`
    this.uploading.add(key)
    try {
      this.storage.sql.exec("INSERT INTO _janitor_archive_upload VALUES (?)", key)
      await this.storage.sync()
      const transfer = new FixedLengthStream(archive.size)
      const controller = new AbortController()
      const pump = archive.body.pipeTo(transfer.writable, { signal: controller.signal })
      try {
        await Promise.all([
          pump,
          this.bucket.put(key, transfer.readable, { sha256: archive.sha256 }),
        ])
      } finally {
        controller.abort()
        await pump.catch(() => {})
      }
    } finally {
      this.uploading.delete(key)
    }
    this.storage.transactionSync(() => {
      if (new RunnerStorage(this.storage).disconnection !== undefined)
        throw new ProtocolError("stale_generation", "Late checkpoint completion fenced")
      this.storage.sql.exec(
        "INSERT OR REPLACE INTO _janitor_checkpoint VALUES (1, ?, ?)",
        key,
        archive.sha256,
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
    const object = await this.bucket?.get(pointer.key)
    if (!object) throw new ProtocolError("blocked", "Committed workspace archive is unavailable")
    return { body: object.body, size: object.size, sha256: pointer.sha256 }
  }
  async prune(all = false) {
    if (all && this.uploading.size > 0)
      throw new ProtocolError("blocked", "Workspace upload is still settling; retry cleanup")
    for (const { key } of this.storage.sql
      .exec<{ key: string }>("SELECT key FROM _janitor_archive_upload")
      .toArray()) {
      if ((!all && key === this.current()?.key) || this.uploading.has(key)) continue
      if (!this.bucket)
        throw new ProtocolError("blocked", "Workspace checkpoint bucket is not configured")
      await this.bucket.delete(key)
      this.storage.sql.exec("DELETE FROM _janitor_archive_upload WHERE key = ?", key)
    }
    await this.storage.sync()
  }
}
