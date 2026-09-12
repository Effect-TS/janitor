import { mkdtempSync, cpSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

// The scratch package is deliberately outside Janitor's pnpm workspace.
const dir = mkdtempSync(join(tmpdir(), "janitor-platform-"))
try {
  cpSync(fileURLToPath(new URL(".", import.meta.url)), dir, { recursive: true })
  const result = spawnSync(
    process.env.JANITOR_VP_BIN || "vp",
    ["run", "--no-cache", process.argv[2] ?? "verify"],
    {
      cwd: dir,
      stdio: "inherit",
    },
  )
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  rmSync(dir, { recursive: true, force: true })
}
