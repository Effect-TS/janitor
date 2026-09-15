// The session Durable Object's SQLite is shared between Janitor, the Cloudflare
// Sandbox SDK and OpenCode. The pinned OpenCode host refuses to bootstrap its
// schema into a database holding foreign tables, and the SDK's scheduler table
// exists before the first turn. These tests run the real bootstrap against a
// database seeded the way production sees it.
import { assert, describe, it } from "vite-plus/test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Cause, Effect, Exit, Layer } from "effect"
import { Database } from "@opencode/core/database/database"
import { Global } from "@opencode/util/global"

/** The statement `@cloudflare/containers` 0.3.7 runs before scheduling a callback. */
const CONTAINER_SCHEDULES =
  "CREATE TABLE IF NOT EXISTS container_schedules (id TEXT PRIMARY KEY NOT NULL DEFAULT (randomblob(9)), callback TEXT NOT NULL, payload TEXT, type TEXT NOT NULL CHECK(type IN ('scheduled', 'delayed')), time INTEGER NOT NULL, delayInSeconds INTEGER, created_at INTEGER DEFAULT (unixepoch()))"

const JANITOR_META =
  "CREATE TABLE IF NOT EXISTS _janitor_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"

const withDatabase = async (seed: ReadonlyArray<string>) => {
  const dir = mkdtempSync(join(tmpdir(), "janitor-opencode-db-"))
  const path = join(dir, "opencode.sqlite")
  const native = new DatabaseSync(path)
  for (const statement of seed) native.exec(statement)
  native.close()
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      yield* Database.Service
    }).pipe(
      // An absolute path bypasses the Global directories; the service only satisfies the layer's type.
      Effect.provide(
        Database.layer({ path }).pipe(
          Layer.provide(Layer.succeed(Global.Service, Global.make({ data: dir, tmp: dir }))),
        ),
      ),
      Effect.scoped,
    ),
  )
  const after = new DatabaseSync(path)
  const tables = after
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => String((row as { name: string }).name))
  after.close()
  rmSync(dir, { recursive: true, force: true })
  return { exit, tables }
}

describe("OpenCode schema bootstrap in the shared session database", () => {
  it("bootstraps beside the Sandbox SDK scheduler table and Janitor tables", async () => {
    const { exit, tables } = await withDatabase([CONTAINER_SCHEDULES, JANITOR_META])
    assert.isTrue(Exit.isSuccess(exit), Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "")
    assert.include(tables, "session_v2")
    assert.include(tables, "container_schedules")
    assert.include(tables, "_janitor_meta")
  })

  it("still refuses a database holding an unknown table", async () => {
    const { exit, tables } = await withDatabase(["CREATE TABLE stranger (id INTEGER PRIMARY KEY)"])
    assert.isTrue(Exit.isFailure(exit))
    assert.include(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "", "stranger")
    assert.notInclude(tables, "session_v2")
  })
})
