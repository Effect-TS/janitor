// Janitor-owned coordination records inside the session Durable Object.
//
// OpenCode owns the unprefixed tables and the Sandbox SDK owns its own; the
// `_janitor_*` tables hold accepted inputs, attempt identity, the recovery
// pointer, turn events and teammate actions beside them, sharing SQLite
// durability. Every mutation is a short synchronous statement; nothing holds a
// lock across an await. The SQL port keeps the records testable outside workerd.
import type { Actor, Awaiting, Generation, InputAttribution, TurnStage } from "./Protocol.ts"

export type SqlValue = string | number | null | ArrayBuffer | Uint8Array

/** The subset of Durable Object SQL the records need; Node's SQLite satisfies it in tests. */
export interface SqlStore {
  readonly exec: <Row = Record<string, SqlValue>>(query: string, ...params: SqlValue[]) => Row[]
  /** Runs `body` inside one SQLite transaction; mutations are atomic with respect to crashes. */
  readonly transaction: <T>(body: () => T) => T
}

export const durableObjectSql = (storage: DurableObjectStorage): SqlStore => ({
  exec: (query, ...params) =>
    storage.sql.exec(query, ...(params as SqlStorageValue[])).toArray() as never,
  transaction: (body) => storage.transactionSync(body),
})

/** The Janitor state format this release writes; older formats are retired at cutover. */
export const JANITOR_STATE_FORMAT = 4

export interface SessionRecord {
  readonly sessionId: string
  readonly generation: Generation
  readonly nativeSessionId: string
  readonly modelConfigurationId: string
  readonly repositoryId: string | null
  readonly title: string
  readonly createdAt: number
}

export type InputStatus = "queued" | "active" | "completed" | "skipped"

export interface InputRecord {
  readonly inputId: string
  readonly seq: number
  readonly payloadHash: string
  readonly text: string
  readonly attribution: InputAttribution
  readonly receivedAt: number
  readonly status: InputStatus
}

export type AttemptState =
  | "running"
  | "completed"
  | "interrupted"
  | "save_failed"
  | "retried"
  | "skipped"

export interface AttemptResult {
  readonly text: string
}

export interface AttemptRecord {
  readonly inputId: string
  readonly attempt: number
  readonly state: AttemptState
  readonly incarnation: string
  readonly startedAt: number
  readonly finishedAt: number | null
  readonly stage: TurnStage | null
  readonly reason: string | null
  /** The finished model work retained while saving is retried. */
  readonly result: AttemptResult | null
}

/** A serializable Sandbox backup handle plus what it captured. */
export interface RecoveryPoint {
  readonly backup: { readonly id: string; readonly dir: string; readonly localBucket?: boolean }
  readonly inputId: string
  readonly attempt: number
  readonly committedAt: number
}

/** What the live container holds, verified against the token written into it. */
export interface WorkspaceState {
  readonly token: string
  /** True from the moment a turn starts until its recovery point is committed. */
  readonly dirty: boolean
  /** The recovery point the container was restored from, or null after a fresh clone. */
  readonly restoredFrom: string | null
  readonly branch: string
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

export interface StoredEvent {
  readonly seq: number
  readonly type: string
  readonly created: number
  readonly data: unknown
}

export interface ActionRecord {
  readonly actionId: string
  readonly inputId: string
  readonly attempt: number
  readonly action: "retry" | "skip"
  readonly actor: Actor
  readonly outcome: string
  readonly at: number
}

const JOURNAL_LIMIT = 400

export class RunnerStorage {
  constructor(readonly sql: SqlStore) {
    sql.exec("CREATE TABLE IF NOT EXISTS _janitor_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    sql.exec(
      "CREATE TABLE IF NOT EXISTS _janitor_input (seq INTEGER PRIMARY KEY AUTOINCREMENT, input_id TEXT NOT NULL UNIQUE, payload_hash TEXT NOT NULL, text TEXT NOT NULL, attribution TEXT NOT NULL, received_at INTEGER NOT NULL, status TEXT NOT NULL)",
    )
    sql.exec(
      "CREATE TABLE IF NOT EXISTS _janitor_attempt (input_id TEXT NOT NULL, attempt INTEGER NOT NULL, state TEXT NOT NULL, incarnation TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, stage TEXT, reason TEXT, result TEXT, PRIMARY KEY (input_id, attempt))",
    )
    sql.exec(
      "CREATE TABLE IF NOT EXISTS _janitor_obsolete_backup (backup_id TEXT PRIMARY KEY, local INTEGER NOT NULL, queued_at INTEGER NOT NULL)",
    )
    sql.exec(
      "CREATE TABLE IF NOT EXISTS _janitor_event (seq INTEGER PRIMARY KEY AUTOINCREMENT, created INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL)",
    )
    sql.exec(
      "CREATE TABLE IF NOT EXISTS _janitor_action (action_id TEXT PRIMARY KEY, input_id TEXT NOT NULL, attempt INTEGER NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, outcome TEXT NOT NULL, at INTEGER NOT NULL)",
    )
    sql.exec(
      "CREATE TABLE IF NOT EXISTS _janitor_journal (seq INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL)",
    )
  }

  private read<T>(key: string): T | undefined {
    const row = this.sql.exec<{ value: string }>(
      "SELECT value FROM _janitor_meta WHERE key = ?",
      key,
    )[0]
    return row === undefined ? undefined : (JSON.parse(row.value) as T)
  }

  private write(key: string, value: unknown) {
    if (value === undefined) {
      this.sql.exec("DELETE FROM _janitor_meta WHERE key = ?", key)
      return
    }
    this.sql.exec(
      "INSERT INTO _janitor_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      JSON.stringify(value),
    )
  }

  transaction<T>(body: () => T): T {
    return this.sql.transaction(body)
  }

  tableExists(name: string): boolean {
    return (
      this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name)
        .length === 1
    )
  }

  /** The state format recorded by whichever runner release wrote this object. */
  get format(): number | undefined {
    return this.read<number>("format")
  }
  set format(value: number) {
    this.write("format", value)
  }

  /**
   * State written by a previous runner family (SQLite workspaces or the first
   * container bridge) predates the recorded format. Cutover cleans it up; until
   * then it is refused rather than reinterpreted.
   */
  get retired(): boolean {
    if (this.format === JANITOR_STATE_FORMAT) return false
    return (
      this.read("compatibility") !== undefined ||
      this.tableExists("_janitor_sql_workspace") ||
      this.tableExists("_janitor_checkpoint")
    )
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
  get intendedRepositoryId(): string | null | undefined {
    return this.read<string | null>("intendedRepositoryId")
  }
  set intendedRepositoryId(repositoryId: string | null) {
    this.write("intendedRepositoryId", repositoryId)
  }

  /** True once the native OpenCode conversation exists for the session. */
  get nativeCreated(): boolean {
    return this.read<boolean>("nativeCreated") ?? false
  }
  set nativeCreated(value: boolean) {
    this.write("nativeCreated", value)
  }

  get modelConfigurationSnapshot(): string | undefined {
    return this.read<string>("modelConfigurationSnapshot")
  }
  set modelConfigurationSnapshot(record: string) {
    this.write("modelConfigurationSnapshot", record)
  }

  get disconnection(): Disconnection | undefined {
    return this.read<Disconnection>("disconnection")
  }
  set disconnection(value: Disconnection) {
    this.write("disconnection", value)
  }

  get awaiting(): Awaiting | undefined {
    return this.read<Awaiting>("awaiting")
  }
  set awaiting(value: Awaiting | undefined) {
    this.write("awaiting", value)
  }

  get workspace(): WorkspaceState | undefined {
    return this.read<WorkspaceState>("workspace")
  }
  set workspace(value: WorkspaceState | undefined) {
    this.write("workspace", value)
  }

  /** Inputs skipped by a teammate whose queued native messages must be cancelled before the next turn. */
  get skipped(): ReadonlyArray<string> {
    return this.read<ReadonlyArray<string>>("skipped") ?? []
  }
  set skipped(value: ReadonlyArray<string>) {
    this.write("skipped", value.length === 0 ? undefined : value)
  }

  get recoveryPoint(): RecoveryPoint | undefined {
    return this.read<RecoveryPoint>("recoveryPoint")
  }
  set recoveryPoint(value: RecoveryPoint | undefined) {
    this.write("recoveryPoint", value)
  }

  // ---------------------------------------------------------------------------
  // Inputs.

  input(inputId: string): InputRecord | undefined {
    const row = this.sql.exec("SELECT * FROM _janitor_input WHERE input_id = ?", inputId)[0]
    return row === undefined ? undefined : decodeInput(row)
  }

  insertInput(record: Omit<InputRecord, "seq" | "status">) {
    this.sql.exec(
      "INSERT OR IGNORE INTO _janitor_input (input_id, payload_hash, text, attribution, received_at, status) VALUES (?, ?, ?, ?, ?, 'queued')",
      record.inputId,
      record.payloadHash,
      record.text,
      JSON.stringify(record.attribution),
      record.receivedAt,
    )
  }

  setInputStatus(inputId: string, status: InputStatus) {
    this.sql.exec("UPDATE _janitor_input SET status = ? WHERE input_id = ?", status, inputId)
  }

  /** The oldest input still waiting for a turn, in acceptance order. */
  nextQueued(): InputRecord | undefined {
    const row = this.sql.exec(
      "SELECT * FROM _janitor_input WHERE status IN ('queued', 'active') ORDER BY seq LIMIT 1",
    )[0]
    return row === undefined ? undefined : decodeInput(row)
  }

  get pendingInputCount(): number {
    return Number(
      this.sql.exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM _janitor_input WHERE status IN ('queued', 'active')",
      )[0]?.n ?? 0,
    )
  }

  get admittedInputCount(): number {
    return Number(
      this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM _janitor_input")[0]?.n ?? 0,
    )
  }

  // ---------------------------------------------------------------------------
  // Attempts.

  attempt(inputId: string, attempt: number): AttemptRecord | undefined {
    const row = this.sql.exec(
      "SELECT * FROM _janitor_attempt WHERE input_id = ? AND attempt = ?",
      inputId,
      attempt,
    )[0]
    return row === undefined ? undefined : decodeAttempt(row)
  }

  attempts(inputId: string): ReadonlyArray<AttemptRecord> {
    return this.sql
      .exec("SELECT * FROM _janitor_attempt WHERE input_id = ? ORDER BY attempt", inputId)
      .map(decodeAttempt)
  }

  /** The attempt still recorded as running, if any; at most one exists. */
  runningAttempt(): AttemptRecord | undefined {
    const row = this.sql.exec("SELECT * FROM _janitor_attempt WHERE state = 'running' LIMIT 1")[0]
    return row === undefined ? undefined : decodeAttempt(row)
  }

  beginAttempt(inputId: string, incarnation: string, startedAt: number): number {
    const previous = Number(
      this.sql.exec<{ n: number | null }>(
        "SELECT MAX(attempt) AS n FROM _janitor_attempt WHERE input_id = ?",
        inputId,
      )[0]?.n ?? 0,
    )
    const attempt = previous + 1
    this.sql.exec(
      "INSERT INTO _janitor_attempt (input_id, attempt, state, incarnation, started_at, stage) VALUES (?, ?, 'running', ?, ?, 'preparing')",
      inputId,
      attempt,
      incarnation,
      startedAt,
    )
    return attempt
  }

  setAttemptStage(inputId: string, attempt: number, stage: TurnStage) {
    this.sql.exec(
      "UPDATE _janitor_attempt SET stage = ? WHERE input_id = ? AND attempt = ?",
      stage,
      inputId,
      attempt,
    )
  }

  finishAttempt(
    inputId: string,
    attempt: number,
    state: Exclude<AttemptState, "running">,
    finishedAt: number,
    reason: string | null = null,
    result: AttemptResult | null = null,
  ) {
    this.sql.exec(
      "UPDATE _janitor_attempt SET state = ?, finished_at = ?, reason = ?, result = ? WHERE input_id = ? AND attempt = ?",
      state,
      finishedAt,
      reason,
      result === null ? null : JSON.stringify(result),
      inputId,
      attempt,
    )
  }

  // ---------------------------------------------------------------------------
  // Recovery.

  queueObsoleteBackup(backupId: string, local: boolean, queuedAt: number) {
    this.sql.exec(
      "INSERT OR IGNORE INTO _janitor_obsolete_backup (backup_id, local, queued_at) VALUES (?, ?, ?)",
      backupId,
      local ? 1 : 0,
      queuedAt,
    )
  }

  get obsoleteBackups(): ReadonlyArray<{ backupId: string; local: boolean }> {
    return this.sql
      .exec<{ backup_id: string; local: number }>(
        "SELECT backup_id, local FROM _janitor_obsolete_backup ORDER BY queued_at",
      )
      .map((row) => ({ backupId: row.backup_id, local: row.local === 1 }))
  }

  removeObsoleteBackup(backupId: string) {
    this.sql.exec("DELETE FROM _janitor_obsolete_backup WHERE backup_id = ?", backupId)
  }

  // ---------------------------------------------------------------------------
  // Turn events: the durable contract consumers read.

  emit(type: string, data: unknown, created: number): number {
    this.sql.exec(
      "INSERT INTO _janitor_event (created, type, data) VALUES (?, ?, ?)",
      created,
      type,
      JSON.stringify(data),
    )
    return this.eventWatermark ?? 0
  }

  events(after: number, limit: number): ReadonlyArray<StoredEvent> {
    return this.sql
      .exec<{ seq: number; created: number; type: string; data: string }>(
        "SELECT seq, created, type, data FROM _janitor_event WHERE seq > ? ORDER BY seq LIMIT ?",
        after,
        limit,
      )
      .map((row) => ({
        seq: row.seq,
        created: row.created,
        type: row.type,
        data: JSON.parse(row.data) as unknown,
      }))
  }

  get eventWatermark(): number | null {
    const row = this.sql.exec<{ seq: number | null }>(
      "SELECT MAX(seq) AS seq FROM _janitor_event",
    )[0]
    return row === undefined || row.seq === null ? null : Number(row.seq)
  }

  // ---------------------------------------------------------------------------
  // Teammate actions.

  action(actionId: string): ActionRecord | undefined {
    const row = this.sql.exec<Record<string, SqlValue>>(
      "SELECT * FROM _janitor_action WHERE action_id = ?",
      actionId,
    )[0]
    if (row === undefined) return undefined
    return {
      actionId: row.action_id as string,
      inputId: row.input_id as string,
      attempt: row.attempt as number,
      action: row.action as "retry" | "skip",
      actor: JSON.parse(row.actor as string) as Actor,
      outcome: row.outcome as string,
      at: row.at as number,
    }
  }

  recordAction(record: ActionRecord) {
    this.sql.exec(
      "INSERT OR IGNORE INTO _janitor_action (action_id, input_id, attempt, action, actor, outcome, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      record.actionId,
      record.inputId,
      record.attempt,
      record.action,
      JSON.stringify(record.actor),
      record.outcome,
      record.at,
    )
  }

  // ---------------------------------------------------------------------------
  // Journal and native reads.

  journal(kind: string, data: unknown = {}, time = Date.now()) {
    this.sql.exec(
      "INSERT INTO _janitor_journal (time, kind, data) VALUES (?, ?, ?)",
      time,
      kind,
      JSON.stringify(data),
    )
    this.sql.exec(
      "DELETE FROM _janitor_journal WHERE seq <= (SELECT MAX(seq) FROM _janitor_journal) - ?",
      JOURNAL_LIMIT,
    )
  }

  get journalEntries(): ReadonlyArray<JournalEntry> {
    return this.sql
      .exec<{ seq: number; time: number; kind: string; data: string }>(
        "SELECT seq, time, kind, data FROM _janitor_journal ORDER BY seq",
      )
      .map((row) => ({
        seq: row.seq,
        time: row.time,
        kind: row.kind,
        data: JSON.parse(row.data) as unknown,
      }))
  }

  /** Native tables exist once the OpenCode SDK has bootstrapped this database. */
  get nativeInitialized(): boolean {
    return this.tableExists("session_v2")
  }

  /** Token totals from the native session row, read without constructing a host. */
  nativeUsage(nativeSessionId: string): Omit<import("./Protocol.ts").UsageTotals, "seq"> | null {
    if (!this.nativeInitialized) return null
    const row = this.sql.exec<Record<string, number | null>>(
      "SELECT tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write FROM session_v2 WHERE id = ?",
      nativeSessionId,
    )[0]
    if (row === undefined) return null
    return {
      input: row.tokens_input ?? 0,
      output: row.tokens_output ?? 0,
      reasoning: row.tokens_reasoning ?? 0,
      cacheRead: row.tokens_cache_read ?? 0,
      cacheWrite: row.tokens_cache_write ?? 0,
    }
  }

  /** The native event watermark for a session; the turn host reads outcomes after it. */
  nativeEventWatermark(nativeSessionId: string): number {
    if (!this.tableExists("event_sequence")) return 0
    const row = this.sql.exec<{ seq: number }>(
      "SELECT seq FROM event_sequence WHERE aggregate_id = ?",
      nativeSessionId,
    )[0]
    return row === undefined ? 0 : Number(row.seq)
  }

  nativeEvents(
    nativeSessionId: string,
    after: number,
  ): ReadonlyArray<{ seq: number; type: string; data: unknown }> {
    if (!this.tableExists("event")) return []
    return this.sql
      .exec<{ seq: number; type: string; data: string }>(
        "SELECT seq, type, data FROM event WHERE aggregate_id = ? AND seq > ? ORDER BY seq",
        nativeSessionId,
        after,
      )
      .map((row) => {
        const split = row.type.lastIndexOf(".")
        const version = Number(row.type.slice(split + 1))
        return {
          seq: row.seq,
          type: Number.isInteger(version) ? row.type.slice(0, split) : row.type,
          data: JSON.parse(row.data) as unknown,
        }
      })
  }
}

const decodeInput = (row: Record<string, SqlValue>): InputRecord => ({
  inputId: row.input_id as string,
  seq: row.seq as number,
  payloadHash: row.payload_hash as string,
  text: row.text as string,
  attribution: JSON.parse(row.attribution as string) as InputAttribution,
  receivedAt: row.received_at as number,
  status: row.status as InputStatus,
})

const decodeAttempt = (row: Record<string, SqlValue>): AttemptRecord => ({
  inputId: row.input_id as string,
  attempt: row.attempt as number,
  state: row.state as AttemptState,
  incarnation: row.incarnation as string,
  startedAt: row.started_at as number,
  finishedAt: (row.finished_at as number | null) ?? null,
  stage: (row.stage as TurnStage | null) ?? null,
  reason: (row.reason as string | null) ?? null,
  result: row.result === null ? null : (JSON.parse(row.result as string) as AttemptResult),
})

export const payloadHash = async (text: string, attribution: InputAttribution) => {
  const bytes = new TextEncoder().encode(JSON.stringify({ text, attribution }))
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}
