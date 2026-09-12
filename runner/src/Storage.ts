// Janitor-owned coordination records inside the session Durable Object.
//
// OpenCode owns the unprefixed tables; its bootstrap ignores `_janitor_*`
// tables, so supervision, receipts and compatibility state live beside the
// native conversation and share its SQLite durability. Every mutation here is
// a short synchronous statement; nothing holds a lock across an await.
import type { Generation, InputAttribution } from "./Protocol.ts"

export interface SessionRecord {
  readonly sessionId: string
  readonly generation: Generation
  readonly nativeSessionId: string
  readonly modelConfigurationId: string
  readonly title: string
  readonly createdAt: number
}

export interface Supervision {
  /** Advances on every admission; idle checks recheck it before clearing a wake. */
  readonly revision: number
  /** True while runnable or recoverable work may exist and the alarm must keep checking. */
  readonly obligation: boolean
  readonly dueAt: number | null
}

export interface Compatibility {
  readonly formatVersion: number
  readonly protocol: number
  readonly release: string
  /** Native migration ids the release that last initialized this database supports. */
  readonly nativeMigrations: ReadonlyArray<string>
  /** Set while a native initialization is in flight; survives a crash mid-migration. */
  readonly inProgress: string | null
}

export interface MaintenanceState {
  readonly held: boolean
  readonly epoch: number | null
}

export interface InputRecord {
  readonly inputId: string
  readonly payloadHash: string
  readonly text: string
  readonly attribution: InputAttribution
  readonly receivedAt: number
  readonly admittedAt: number | null
}

export interface Disconnection {
  readonly generation: Generation
  readonly at: number
}

export interface JournalEntry {
  readonly seq: number
  readonly time: number
  readonly kind: string
  readonly data: unknown
}

const JOURNAL_LIMIT = 400

export class RunnerStorage {
  constructor(readonly storage: DurableObjectStorage) {
    const sql = storage.sql
    sql.exec("CREATE TABLE IF NOT EXISTS _janitor_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    sql.exec(
      "CREATE TABLE IF NOT EXISTS _janitor_input (input_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, text TEXT NOT NULL, attribution TEXT NOT NULL, received_at INTEGER NOT NULL, admitted_at INTEGER)",
    )
    sql.exec(
      "CREATE TABLE IF NOT EXISTS _janitor_journal (seq INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL)",
    )
  }

  private read<T>(key: string): T | undefined {
    const row = this.storage.sql
      .exec("SELECT value FROM _janitor_meta WHERE key = ?", key)
      .toArray()[0]
    return row === undefined ? undefined : (JSON.parse(row.value as string) as T)
  }

  private write(key: string, value: unknown) {
    this.storage.sql.exec(
      "INSERT INTO _janitor_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      JSON.stringify(value),
    )
  }

  /** Runs `body` inside one SQLite transaction; mutations are atomic with respect to crashes. */
  transaction<T>(body: () => T): T {
    return this.storage.transactionSync(body)
  }

  get session(): SessionRecord | undefined {
    return this.read<SessionRecord>("session")
  }
  set session(record: SessionRecord) {
    this.write("session", record)
  }

  get intendedNativeSessionId(): string | undefined {
    return this.read<string>("intendedNativeSessionId")
  }
  set intendedNativeSessionId(id: string) {
    this.write("intendedNativeSessionId", id)
  }

  get intendedModelConfigurationId(): string | undefined {
    return this.read<string>("intendedModelConfigurationId")
  }
  set intendedModelConfigurationId(id: string) {
    this.write("intendedModelConfigurationId", id)
  }

  get intendedGeneration(): Generation | undefined {
    return this.read<Generation>("intendedGeneration")
  }
  set intendedGeneration(generation: Generation) {
    this.write("intendedGeneration", generation)
  }

  get supervision(): Supervision {
    return this.read<Supervision>("supervision") ?? { revision: 0, obligation: false, dueAt: null }
  }
  set supervision(value: Supervision) {
    this.write("supervision", value)
  }

  get compatibility(): Compatibility | undefined {
    return this.read<Compatibility>("compatibility")
  }
  set compatibility(value: Compatibility) {
    this.write("compatibility", value)
  }

  get maintenance(): MaintenanceState {
    return this.read<MaintenanceState>("maintenance") ?? { held: false, epoch: null }
  }
  set maintenance(value: MaintenanceState) {
    this.write("maintenance", value)
  }

  /** Persisted reasons that must block host construction until an operator resolves them. */
  get blockers(): ReadonlyArray<string> {
    return this.read<ReadonlyArray<string>>("blockers") ?? []
  }
  set blockers(value: ReadonlyArray<string>) {
    this.write("blockers", value)
  }

  get disconnection(): Disconnection | undefined {
    return this.read<Disconnection>("disconnection")
  }
  set disconnection(value: Disconnection) {
    this.write("disconnection", value)
  }

  /** Native tables exist once the SDK has bootstrapped this database. */
  get nativeInitialized(): boolean {
    return (
      this.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_v2'")
        .toArray().length === 1
    )
  }

  get nativeMigrations(): ReadonlyArray<string> {
    const exists =
      this.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration'")
        .toArray().length === 1
    if (!exists) return []
    return this.storage.sql
      .exec("SELECT id FROM migration ORDER BY id")
      .toArray()
      .map((row) => row.id as string)
  }

  input(inputId: string): InputRecord | undefined {
    const row = this.storage.sql
      .exec("SELECT * FROM _janitor_input WHERE input_id = ?", inputId)
      .toArray()[0]
    return row === undefined ? undefined : decodeInput(row)
  }

  insertInput(record: InputRecord) {
    this.storage.sql.exec(
      "INSERT OR IGNORE INTO _janitor_input (input_id, payload_hash, text, attribution, received_at, admitted_at) VALUES (?, ?, ?, ?, ?, ?)",
      record.inputId,
      record.payloadHash,
      record.text,
      JSON.stringify(record.attribution),
      record.receivedAt,
      record.admittedAt,
    )
  }

  markAdmitted(inputId: string, admittedAt: number) {
    this.storage.sql.exec(
      "UPDATE _janitor_input SET admitted_at = COALESCE(admitted_at, ?) WHERE input_id = ?",
      admittedAt,
      inputId,
    )
  }

  get admittedInputCount(): number {
    return Number(
      this.storage.sql
        .exec("SELECT COUNT(*) AS n FROM _janitor_input WHERE admitted_at IS NOT NULL")
        .toArray()[0]?.n ?? 0,
    )
  }

  journal(kind: string, data: unknown = {}) {
    this.storage.sql.exec(
      "INSERT INTO _janitor_journal (time, kind, data) VALUES (?, ?, ?)",
      Date.now(),
      kind,
      JSON.stringify(data),
    )
    this.storage.sql.exec(
      "DELETE FROM _janitor_journal WHERE seq <= (SELECT MAX(seq) FROM _janitor_journal) - ?",
      JOURNAL_LIMIT,
    )
  }

  get journalEntries(): ReadonlyArray<JournalEntry> {
    return this.storage.sql
      .exec("SELECT seq, time, kind, data FROM _janitor_journal ORDER BY seq")
      .toArray()
      .map((row) => ({
        seq: row.seq as number,
        time: row.time as number,
        kind: row.kind as string,
        data: JSON.parse(row.data as string),
      }))
  }

  /** Native session row facts the supervisor reads without constructing a host. */
  nativeSession(nativeSessionId: string): NativeSessionRow | undefined {
    if (!this.nativeInitialized) return undefined
    const row = this.storage.sql
      .exec(
        "SELECT id, time_suspended, resume_attempts, time_idle, idle_outcome, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write FROM session_v2 WHERE id = ?",
        nativeSessionId,
      )
      .toArray()[0]
    if (row === undefined) return undefined
    return {
      id: row.id as string,
      timeSuspended: (row.time_suspended as number | null) ?? null,
      resumeAttempts: (row.resume_attempts as number) ?? 0,
      timeIdle: (row.time_idle as number | null) ?? null,
      idleOutcome: (row.idle_outcome as string | null) ?? null,
      tokens: {
        input: (row.tokens_input as number) ?? 0,
        output: (row.tokens_output as number) ?? 0,
        reasoning: (row.tokens_reasoning as number) ?? 0,
        cacheRead: (row.tokens_cache_read as number) ?? 0,
        cacheWrite: (row.tokens_cache_write as number) ?? 0,
      },
    }
  }

  /** Inbox entries not yet promoted, and how many arrived after the last idle transition. */
  pendingInbox(
    nativeSessionId: string,
    since: number | null,
  ): { total: number; sinceIdle: number } {
    if (!this.nativeInitialized) return { total: 0, sinceIdle: 0 }
    const rows = this.storage.sql
      .exec("SELECT time_created FROM session_inbox WHERE session_id = ?", nativeSessionId)
      .toArray()
    const total = rows.length
    const sinceIdle =
      since === null
        ? total
        : rows.filter((row) => ((row.time_created as number) ?? 0) > since).length
    return { total, sinceIdle }
  }

  /** The message of the most recent terminal execution failure, if any. */
  lastFailureMessage(nativeSessionId: string): string | null {
    if (!this.nativeInitialized) return null
    const row = this.storage.sql
      .exec(
        "SELECT data FROM event WHERE aggregate_id = ? AND type LIKE 'session.execution.failed.%' ORDER BY seq DESC LIMIT 1",
        nativeSessionId,
      )
      .toArray()[0]
    if (row === undefined || typeof row.data !== "string") return null
    const parsed = JSON.parse(row.data) as { error?: { message?: unknown } }
    return typeof parsed.error?.message === "string" ? parsed.error.message : null
  }

  eventWatermark(nativeSessionId: string): number | null {
    if (!this.nativeInitialized) return null
    const row = this.storage.sql
      .exec("SELECT seq FROM event_sequence WHERE aggregate_id = ?", nativeSessionId)
      .toArray()[0]
    return row === undefined ? null : (row.seq as number)
  }

  events(nativeSessionId: string, after: number, limit: number): ReadonlyArray<StoredEvent> {
    if (!this.nativeInitialized) return []
    return this.storage.sql
      .exec(
        "SELECT id, seq, created, type, data FROM event WHERE aggregate_id = ? AND seq > ? ORDER BY seq LIMIT ?",
        nativeSessionId,
        after,
        limit,
      )
      .toArray()
      .map((row) => {
        const stored = row.type as string
        const split = stored.lastIndexOf(".")
        const version = Number(stored.slice(split + 1))
        return {
          id: row.id as string,
          seq: row.seq as number,
          created: row.created as number,
          type: Number.isInteger(version) ? stored.slice(0, split) : stored,
          version: Number.isInteger(version) ? version : 0,
          data: JSON.parse(row.data as string) as unknown,
        }
      })
  }
}

export interface NativeSessionRow {
  readonly id: string
  readonly timeSuspended: number | null
  readonly resumeAttempts: number
  readonly timeIdle: number | null
  readonly idleOutcome: string | null
  readonly tokens: {
    readonly input: number
    readonly output: number
    readonly reasoning: number
    readonly cacheRead: number
    readonly cacheWrite: number
  }
}

export interface StoredEvent {
  readonly id: string
  readonly seq: number
  readonly created: number
  readonly type: string
  readonly version: number
  readonly data: unknown
}

const decodeInput = (row: Record<string, SqlStorageValue>): InputRecord => ({
  inputId: row.input_id as string,
  payloadHash: row.payload_hash as string,
  text: row.text as string,
  attribution: JSON.parse(row.attribution as string) as InputAttribution,
  receivedAt: row.received_at as number,
  admittedAt: (row.admitted_at as number | null) ?? null,
})

export const payloadHash = async (text: string, attribution: InputAttribution) => {
  const bytes = new TextEncoder().encode(JSON.stringify({ text, attribution }))
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}
