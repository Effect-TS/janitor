import { execFile } from "node:child_process"
import { readdir } from "node:fs/promises"
import { promisify } from "node:util"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, beforeAll, expect, it } from "vite-plus/test"

const run = promisify(execFile)
let container: StartedPostgreSqlContainer

beforeAll(async () => {
  const migrations = new URL("../migrations/", import.meta.url)
  const files = (await readdir(migrations)).filter((file) => file.endsWith(".sql")).sort()
  container = await new PostgreSqlContainer("postgres:18-alpine")
    .withCopyFilesToContainer(
      files.map((file) => ({
        source: new URL(file, migrations).pathname,
        target: `/docker-entrypoint-initdb.d/${file}`,
      })),
    )
    .start()
}, 60_000)

afterAll(async () => {
  await container?.stop()
})

const seed = () =>
  run(process.execPath, [new URL("../seed/main.ts", import.meta.url).pathname], {
    env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
  })

const query = async (sql: string) => {
  const result = await container.exec([
    "psql",
    "-U",
    container.getUsername(),
    "-d",
    container.getDatabase(),
    "-v",
    "ON_ERROR_STOP=1",
    "-Atc",
    sql,
  ])
  expect(result.exitCode).toBe(0)
  return result.output.trim()
}

it("seeds the baseline and rolls back all changes when a later seed fails", async () => {
  const result = await seed()
  expect(result.stdout).toContain("seed complete")
  expect(await query("SELECT count(*) FROM github_repository WHERE sync_enabled")).toBe("0")
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
