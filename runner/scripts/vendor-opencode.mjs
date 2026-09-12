// Extracts the pinned OpenCode workspace packages into runner/vendor.
//
// The runner is built against OpenCode source at an exact revision rather than
// a registry release: the Workerd Effect SDK is not published as an equivalent
// artifact. Set OPENCODE_SOURCE to an existing clone that contains the revision
// to skip the network; otherwise a blob-less clone is fetched into a temporary
// directory. Manifests lose scripts/devDependencies and optional UI peers so the
// install stays bounded; runtime source files are copied unchanged.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"

const here = path.dirname(new URL(import.meta.url).pathname)
const root = path.resolve(here, "..")
const pin = JSON.parse(fs.readFileSync(path.join(root, "opencode.json"), "utf8"))
const vendor = path.join(root, "vendor")
const marker = path.join(vendor, "SOURCE.json")

if (fs.existsSync(marker) && !process.argv.includes("--force")) {
  const existing = JSON.parse(fs.readFileSync(marker, "utf8"))
  if (existing.revision === pin.revision) {
    console.log(`OpenCode ${pin.revision.slice(0, 12)} already vendored.`)
    process.exit(0)
  }
}

const git = (source, args, options = {}) =>
  execFileSync("git", ["-C", source, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  })

let source = process.env.OPENCODE_SOURCE
let temporary
if (source) {
  try {
    git(source, ["cat-file", "-e", `${pin.revision}^{commit}`])
  } catch {
    throw new Error(`OPENCODE_SOURCE=${source} does not contain revision ${pin.revision}`)
  }
} else {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), "janitor-opencode-"))
  source = temporary
  execFileSync("git", ["init", "-q", source])
  execFileSync("git", ["-C", source, "remote", "add", "origin", pin.repository])
  execFileSync(
    "git",
    ["-C", source, "fetch", "-q", "--depth=1", "--filter=blob:none", "origin", pin.revision],
    {
      stdio: "inherit",
    },
  )
}

const show = (file) =>
  git(source, ["show", `${pin.revision}:${file}`], { stdio: ["ignore", "pipe", "ignore"] })
const catalog = JSON.parse(show("package.json")).workspaces.catalog
const directories = git(source, ["ls-tree", "--name-only", `${pin.revision}:packages`])
  .trim()
  .split("\n")
const packages = new Map()
for (const dir of directories) {
  try {
    const manifest = JSON.parse(show(`packages/${dir}/package.json`))
    packages.set(manifest.name, { dir, manifest })
  } catch {
    // Directories without a package manifest are not workspace packages.
  }
}
const chosen = new Map()
const collect = (name) => {
  if (chosen.has(name)) return
  const item = packages.get(name)
  if (!item) throw new Error(`Missing workspace package ${name}`)
  chosen.set(name, item)
  for (const [dependency, range] of Object.entries(item.manifest.dependencies ?? {}))
    if (range.startsWith("workspace:")) collect(dependency)
}
for (const name of pin.roots) collect(name)

fs.rmSync(vendor, { recursive: true, force: true })
fs.mkdirSync(vendor, { recursive: true })
const paths = [...chosen.values()].map((item) => `packages/${item.dir}`)
const archive = execFileSync("git", ["-C", source, "archive", pin.revision, ...paths], {
  maxBuffer: 512 * 1024 * 1024,
})
execFileSync("tar", ["-x", "-C", vendor], { input: archive })

for (const { dir, manifest } of chosen.values()) {
  for (const excluded of pin.excludedDirectories)
    fs.rmSync(path.join(vendor, "packages", dir, excluded), { recursive: true, force: true })
  delete manifest.devDependencies
  delete manifest.scripts
  for (const name of Object.keys(manifest.peerDependencies ?? {}))
    if (manifest.peerDependenciesMeta?.[name]?.optional) {
      delete manifest.peerDependencies[name]
      delete manifest.peerDependenciesMeta[name]
    }
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"])
    for (const [name, range] of Object.entries(manifest[field] ?? {}))
      if (range === "catalog:") {
        if (!catalog[name]) throw new Error(`Missing upstream catalog entry ${name}`)
        manifest[field][name] = catalog[name]
      }
  fs.writeFileSync(
    path.join(vendor, "packages", dir, "package.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  )
}

const hash = createHash("sha256")
const walk = (directory) => {
  for (const entry of fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) walk(full)
    else {
      hash.update(path.relative(vendor, full))
      hash.update(fs.readFileSync(full))
    }
  }
}
walk(path.join(vendor, "packages"))
fs.writeFileSync(
  marker,
  JSON.stringify(
    {
      repository: pin.repository,
      revision: pin.revision,
      packages: paths,
      contentHash: hash.digest("hex"),
      manifestChanges:
        "Removed scripts, devDependencies, optional UI peers and test/example directories; resolved upstream catalog ranges. Runtime source unchanged.",
    },
    null,
    2,
  ) + "\n",
)
if (temporary) fs.rmSync(temporary, { recursive: true, force: true })
console.log(`Vendored ${chosen.size} OpenCode packages at ${pin.revision.slice(0, 12)}.`)
