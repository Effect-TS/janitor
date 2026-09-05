import { createHash } from "node:crypto"
import { readFileSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"

const root = createRequire(new URL("../package.json", import.meta.url))
const backend = createRequire(new URL("../apps/cluster/package.json", import.meta.url))
const expected = realpathSync(root.resolve("effect/package.json"))
if (realpathSync(backend.resolve("effect/package.json")) !== expected)
  throw new Error(
    "The backend resolves a different Effect package. Remove the stale apps/cluster/node_modules/effect link and run vp install --frozen-lockfile.",
  )
const manifest = JSON.parse(
  readFileSync(new URL("../vendor/effect-artifacts.json", import.meta.url), "utf8"),
)
if (JSON.parse(readFileSync(expected, "utf8")).gitHead !== manifest.revision)
  throw new Error("Installed backend Effect does not match the pinned revision")
for (const artifact of manifest.artifacts) {
  const bytes = readFileSync(new URL(`../${artifact.file}`, import.meta.url))
  if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256)
    throw new Error(`Vendor artifact integrity mismatch: ${artifact.file}`)
}
