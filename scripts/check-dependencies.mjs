import { existsSync, globSync, readFileSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseAllDocuments } from "yaml"

const root = fileURLToPath(new URL("../", import.meta.url))
const readYaml = (file) =>
  parseAllDocuments(readFileSync(resolve(root, file), "utf8")).map((document) => {
    if (document.errors.length) throw document.errors[0]
    return document.toJS()
  })
const catalog = readYaml("pnpm-workspace.yaml")[0].catalog
const revision = /@([a-f0-9]{40})$/.exec(catalog.effect)?.[1]
if (!revision) throw new Error("Pin Effect to a full snapshot commit in the catalog")
const snapshots = Object.entries(catalog).filter(([, spec]) =>
  spec.startsWith("https://pkg.pr.new/"),
)
const approved = new Set(snapshots.map(([, spec]) => spec))
for (const [name, spec] of snapshots) {
  if (spec !== `https://pkg.pr.new/Effect-TS/effect/${name}@${revision}`)
    throw new Error(`Snapshot commit mismatch: ${name}`)
}
// pnpm cannot selectively allow exotic subdependencies. Enforce the narrower
// snapshot allowlist here for both the committed and installed dependency graph.
for (const file of ["pnpm-lock.yaml", "node_modules/.pnpm/lock.yaml"]) {
  const packages = Object.assign({}, ...readYaml(file).map((document) => document.packages))
  for (const [id, { resolution }] of Object.entries(packages)) {
    if (resolution.tarball && !approved.has(resolution.tarball))
      throw new Error(`Unapproved tarball in ${file}: ${id}`)
    if (resolution.type === "git" || resolution.repo)
      throw new Error(`Unapproved Git dependency in ${file}: ${id}`)
  }
  for (const [name, spec] of snapshots) {
    const entries = Object.entries(packages).filter(([id]) => id.startsWith(`${name}@`))
    if (
      entries.length !== 1 ||
      entries[0][1].resolution.tarball !== spec ||
      !entries[0][1].resolution.integrity
    )
      throw new Error(
        `${file} must resolve ${name} exclusively to its pinned snapshot with integrity`,
      )
  }
}
const expected = realpathSync(
  createRequire(resolve(root, "package.json")).resolve("effect/package.json"),
)
if (!expected.startsWith(resolve(root, "node_modules") + "/"))
  throw new Error("Effect must resolve inside this installation, not an external checkout")
const queue = [
  ...globSync(["package.json", "apps/*/package.json", "packages/*/package.json"], { cwd: root }),
].map((file) => resolve(root, file))
const visited = new Set()
while (queue.length) {
  const file = realpathSync(queue.pop())
  if (visited.has(file)) continue
  visited.add(file)
  const manifest = JSON.parse(readFileSync(file, "utf8"))
  const require = createRequire(file)
  const dependencies = { ...manifest.dependencies, ...manifest.peerDependencies }
  if (!file.includes("node_modules")) Object.assign(dependencies, manifest.devDependencies)
  if (dependencies.effect && realpathSync(require.resolve("effect/package.json")) !== expected)
    throw new Error(`${manifest.name} resolves a different Effect runtime; reinstall dependencies`)
  for (const name of Object.keys(dependencies)) {
    // Inspect manifests without depending on a package.json export. Optional
    // peers may be absent; every installed consumer is checked above.
    const dependency = require.resolve
      .paths(name)
      ?.map((directory) => resolve(directory, name, "package.json"))
      .find(existsSync)
    if (dependency) queue.push(dependency)
  }
}
console.log(`Effect snapshot ${revision}: lockfile integrity and runtime resolution verified`)
