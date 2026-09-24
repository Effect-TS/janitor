import { execFile } from "node:child_process"
import { promisify } from "node:util"
import * as PgClient from "@effect/sql-pg/PgClient"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Redacted from "effect/Redacted"
import * as Scope from "effect/Scope"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { afterAll, beforeAll, expect, it } from "vite-plus/test"
import { migratedDatabase } from "./support/Postgres.ts"

const run = promisify(execFile)
let scope: Scope.Closeable
let url: string

beforeAll(async () => {
  scope = await Effect.runPromise(Scope.make())
  url = (await Effect.runPromise(Scope.provide(migratedDatabase, scope))).url
}, 60_000)

afterAll(async () => {
  if (scope) await Effect.runPromise(Scope.close(scope, Exit.void))
})

const seed = () =>
  run(process.execPath, [new URL("../seed/main.ts", import.meta.url).pathname], {
    env: { ...process.env, DATABASE_URL: url },
  })

/** Runs `text` and returns the first column of its first row, as `psql -At` would. */
const query = (text: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql.unsafe(text).unprepared
      const first = rows[0]
      return first === undefined ? "" : String(Object.values(first)[0])
    }).pipe(Effect.provide(PgClient.layer({ url: Redacted.make(url) })), Effect.scoped),
  )

it("seeds the baseline and rolls back all changes when a later seed fails", async () => {
  const result = await seed()
  expect(result.stdout).toContain("seed complete")
  expect(await query("SELECT count(*) FROM github_installation WHERE sync_enabled")).toBe("0")
  expect(
    Number(await query("SELECT count(*) FROM github_repository WHERE enabled")),
  ).toBeGreaterThan(0)
  expect(Number(await query("SELECT count(*) FROM github_pull_request"))).toBeGreaterThan(0)

  // Reproduce an old schema after a successful seed. The failed replacement
  // must preserve this edited data despite having already run TRUNCATE.
  await query("UPDATE github_entity SET title = 'keep this local edit'")
  const before = await query("SELECT count(*) FROM github_entity")
  await query("ALTER TABLE github_pull_request DROP COLUMN github_updated_at")
  await expect(seed()).rejects.toThrow('column "github_updated_at"')
  expect(
    await query("SELECT count(*) FROM github_entity WHERE title = 'keep this local edit'"),
  ).toBe(before)
}, 60_000)
