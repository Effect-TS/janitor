// In-memory ports for coordinator tests: Node's SQLite stands in for Durable
// Object SQL, and the sandbox, model host, recovery store and scheduler are
// scripted so the turn contract can be exercised without workerd or Docker.
import { DatabaseSync } from "node:sqlite"
import { Effect } from "effect"
import { RunnerStorage, type SqlStore, type SqlValue } from "../../src/Storage.ts"
import { KeyValue } from "../../src/services/KeyValue.ts"
import { RecoveryStore } from "../../src/services/RecoveryStore.ts"
import { WorkspaceReadiness } from "../../src/services/WorkspaceReadiness.ts"
import { RepositoryCheckout } from "../../src/services/RepositoryCheckout.ts"
import {
  REPOSITORY_DIR,
  RUNTIME_TOKEN_PATH,
  WorkspaceError,
  type BackupHandle,
  type ExecOutcome,
  type SandboxWorkspace,
} from "../../src/services/SandboxWorkspace.ts"
import {
  DEFAULT_COORDINATOR_OPTIONS,
  SessionCoordinator,
  type CoordinatorOptions,
} from "../../src/services/SessionCoordinator.ts"
import {
  HostError,
  type TurnHost,
  type TurnOutcome,
  type TurnRequest,
  type TurnScheduler,
} from "../../src/services/TurnHost.ts"
import { WorkspacePublication } from "../../src/services/WorkspacePublication.ts"

export const nodeSql = (): SqlStore => {
  const db = new DatabaseSync(":memory:")
  let depth = 0
  return {
    exec: <Row>(query: string, ...params: SqlValue[]) => {
      const statement = db.prepare(query)
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(query))
        return statement.all(...(params as never[])) as Row[]
      statement.run(...(params as never[]))
      return [] as Row[]
    },
    transaction: (body) => {
      if (depth > 0) return body()
      depth++
      db.exec("BEGIN")
      try {
        const result = body()
        db.exec("COMMIT")
        return result
      } catch (error) {
        db.exec("ROLLBACK")
        throw error
      } finally {
        depth--
      }
    },
  }
}

/** A scripted container: files, executed commands, backups and replacement. */
export class FakeSandbox {
  generation = 0
  files = new Map<string, string>()
  backups = new Map<string, Map<string, string>>()
  deleted: string[] = []
  commands: string[] = []
  stops = 0
  activity = 0
  /** Fails the next N backup creations. */
  backupFailures = 0
  /** Git state the fake reports for publication commands. */
  git: { head: string; remoteHead: string | null; containsRemote: boolean } = {
    head: "a".repeat(40),
    remoteHead: null,
    containsRemote: false,
  }
  restoreCount = 0
  cloneCount = 0
  /** Delays the next clone until the promise settles, so tests can order the model against it. */
  beforeClone: (() => Promise<void>) | undefined
  /** Fails clones with this message while set. */
  cloneFailure: string | undefined

  /** Simulates the container being replaced: files and processes are gone. */
  replace() {
    this.generation++
    this.files = new Map()
  }

  readonly service: SandboxWorkspace["Service"] = {
    generation: () => this.generation,
    exec: (raw) => {
      const run = Effect.sync((): ExecOutcome => {
        // Commands arrive shell-quoted for the workspace user; match on the plain text.
        const command = raw.replaceAll("'\\''", "").replaceAll("'", "")
        this.commands.push(command)
        const ok = (stdout = ""): ExecOutcome => ({
          exitCode: 0,
          stdout,
          stderr: "",
          timedOut: false,
          durationMs: 1,
        })
        const fail = (stderr: string): ExecOutcome => ({
          exitCode: 1,
          stdout: "",
          stderr,
          timedOut: false,
          durationMs: 1,
        })
        if (command.includes("git clone")) {
          this.cloneCount++
          if (this.cloneFailure !== undefined) return fail(this.cloneFailure)
          this.files.set(`${REPOSITORY_DIR}/.git/HEAD`, "ref: refs/heads/main")
          this.files.set(`${REPOSITORY_DIR}/README.md`, "seed")
          return ok()
        }
        if (command.includes("rev-parse --abbrev-ref HEAD")) return ok("main")
        if (command.includes("test -d"))
          return this.files.has(`${REPOSITORY_DIR}/.git/HEAD`) ? ok() : fail("missing")
        if (command.includes("cat-file -e")) return this.git.containsRemote ? fail("missing") : ok()
        if (command.includes("rev-parse --verify --quiet HEAD")) return ok(this.git.head)
        if (command.includes("rev-parse --verify --quiet refs/remotes/origin/"))
          return this.git.remoteHead === null ? fail("") : ok(this.git.remoteHead)
        if (command.includes("git fetch"))
          return this.git.remoteHead === null ? fail("couldn't find remote ref") : ok()
        if (command.includes("merge-base --is-ancestor"))
          return this.git.containsRemote ? ok() : fail("")
        if (command.includes("checkout -B")) {
          this.commands.push("adopted")
          return ok()
        }
        if (command.startsWith("mkdir") || command.startsWith("chown") || command.includes("chown"))
          return ok()
        return ok()
      })
      const before = this.beforeClone
      if (before !== undefined && raw.includes("git clone")) {
        this.beforeClone = undefined
        return Effect.promise(before).pipe(Effect.andThen(run))
      }
      return run
    },
    readFile: (path) => Effect.sync(() => this.files.get(path) ?? null),
    writeFile: (path, content) =>
      Effect.sync(() => {
        this.files.set(path, content)
      }),
    stopProcesses: Effect.sync(() => {
      this.stops++
    }),
    createBackup: (request) =>
      Effect.suspend(() => {
        if (this.backupFailures > 0) {
          this.backupFailures--
          return Effect.fail(new WorkspaceError({ reason: "failed", message: "upload failed" }))
        }
        const id = crypto.randomUUID()
        this.backups.set(
          id,
          new Map([...this.files].filter(([path]) => path.startsWith(request.dir))),
        )
        return Effect.succeed<BackupHandle>({
          id,
          dir: request.dir,
          ...(request.local ? { localBucket: true } : {}),
        })
      }),
    restoreBackup: (backup) =>
      Effect.suspend(() => {
        const contents = this.backups.get(backup.id)
        if (contents === undefined)
          return Effect.fail(new WorkspaceError({ reason: "failed", message: "backup missing" }))
        this.restoreCount++
        // A restore replaces the directory: nothing written since the backup survives.
        for (const path of [...this.files.keys()])
          if (path.startsWith(backup.dir)) this.files.delete(path)
        for (const [path, content] of contents) this.files.set(path, content)
        return Effect.void
      }),
    deleteBackup: (backup) =>
      Effect.sync(() => {
        this.deleted.push(backup.id)
        this.backups.delete(backup.id)
      }),
    destroy: Effect.sync(() => this.replace()),
    renewActivity: () => {
      this.activity++
    },
  }
}

/** A scripted model: outcomes are consumed in order; unscripted turns complete with an echo. */
export class FakeHost {
  outcomes: Array<TurnOutcome | ((turn: TurnRequest) => Effect.Effect<TurnOutcome, HostError>)> = []
  turns: TurnRequest[] = []
  disposed = 0
  /** Files the model writes during each turn, applied to the sandbox. */
  writes: Array<[string, string]> = []
  constructor(private readonly sandbox: FakeSandbox) {}
  readonly service: TurnHost["Service"] = {
    run: (turn) =>
      Effect.suspend(() => {
        this.turns.push(turn)
        for (const [path, content] of this.writes) this.sandbox.files.set(path, content)
        const next = this.outcomes.shift()
        if (next === undefined)
          return Effect.succeed<TurnOutcome>({ type: "completed", text: `echo:${turn.text}` })
        return typeof next === "function" ? next(turn) : Effect.succeed(next)
      }),
    dispose: Effect.sync(() => {
      this.disposed++
    }),
  }
}

export interface Harness {
  readonly store: RunnerStorage
  readonly sandbox: FakeSandbox
  readonly host: FakeHost
  readonly kv: KeyValue["Service"]
  readonly coordinator: SessionCoordinator["Service"]
  readonly wakes: number[]
  /** How many times the coordinator told the API that events are readable. */
  readonly notifies: { count: number }
  /** The tool gate; tests wait on it the way a sandbox tool does. */
  readonly readiness: WorkspaceReadiness
  readonly clock: { now: number }
  /** Runs every wake the coordinator requested until the queue is quiet. */
  readonly settle: () => Promise<void>
  readonly restart: (incarnation?: string) => Harness
}

export const harness = (
  options: Partial<CoordinatorOptions> & {
    incarnation?: string
    sql?: SqlStore
    sandbox?: FakeSandbox
    kv?: KeyValue["Service"]
    clock?: { now: number }
    notifies?: { count: number }
  } = {},
): Harness => {
  const sql = options.sql ?? nodeSql()
  const store = new RunnerStorage(sql)
  const sandbox = options.sandbox ?? new FakeSandbox()
  const host = new FakeHost(sandbox)
  const kv = options.kv ?? KeyValue.memory()
  const clock = options.clock ?? { now: 1_000 }
  const wakes: number[] = []
  const notifies = options.notifies ?? { count: 0 }
  const readiness = new WorkspaceReadiness()
  const scheduler: TurnScheduler["Service"] = {
    wake: (delayMs) =>
      Effect.sync(() => {
        wakes.push(delayMs)
      }),
  }
  const recovery = RecoveryStore.make(store, sandbox.service, { local: true })
  const publication = WorkspacePublication.make(
    sandbox.service,
    kv,
    () => "https://github.com/o/r.git",
  )
  const checkout = RepositoryCheckout.make(
    {
      store,
      credential: () => Effect.succeed({ owner: "o", repo: "r", token: "secret" }),
      associatedBranch: () => Effect.succeed(null),
      remote: () => "https://github.com/o/r.git",
      clock: () => clock.now,
    },
    sandbox.service,
    recovery,
    publication,
  )
  const coordinator = SessionCoordinator.make(
    {
      store,
      incarnation: options.incarnation ?? "inc-1",
      options: () => ({ ...DEFAULT_COORDINATOR_OPTIONS, saveRetryDelayMs: 1, ...options }),
      clock: () => clock.now,
      release: () => "test",
      guard: () => null,
      resolveModelConfiguration: (requested) => requested ?? "default",
      notify: () => {
        notifies.count++
      },
      readiness,
    },
    host.service,
    checkout,
    recovery,
    sandbox.service,
    scheduler,
  )
  const settle = async () => {
    for (let round = 0; round < 20 && wakes.length > 0; round++) {
      wakes.length = 0
      clock.now += 1_000
      await Effect.runPromise(coordinator.drive)
    }
  }
  return {
    store,
    sandbox,
    host,
    kv,
    coordinator,
    wakes,
    notifies,
    readiness,
    clock,
    settle,
    restart: (incarnation = "inc-2") =>
      harness({ ...options, incarnation, sql, sandbox, kv, clock, notifies }),
  }
}

export const runtimeToken = (sandbox: FakeSandbox) => sandbox.files.get(RUNTIME_TOKEN_PATH)
