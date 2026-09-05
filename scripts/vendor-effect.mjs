import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

const revision = "f4143802256d135864f15314fc37385e919999b1"
const checkout = resolve(process.argv[2] ?? "../effect")
const temporary = mkdtempSync(`${tmpdir()}/janitor-effect-`)
const run = (command, args) => execFileSync(command, args, { stdio: "inherit" })
try {
  // Read committed sources only. Uncommitted changes in the checkout are excluded.
  const archive = execFileSync(
    "git",
    ["-C", checkout, "archive", revision, "packages/effect", "packages/vitest", "LICENSE"],
    { maxBuffer: 100 * 1024 * 1024 },
  )
  execFileSync("tar", ["-x", "-C", temporary], { input: archive })
  const artifacts = []
  for (const name of ["effect", "vitest"]) {
    const source = `${temporary}/packages/${name}`
    const packageDir = `${temporary}/${name}/package`
    mkdirSync(packageDir, { recursive: true })
    const manifest = JSON.parse(readFileSync(`${source}/package.json`, "utf8"))
    writeFileSync(
      `${source}/tsconfig.vendor.json`,
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          rootDir: "src",
          outDir: `${packageDir}/dist`,
          declaration: true,
          noCheck: true,
          rewriteRelativeImportExtensions: true,
          types: [],
        },
        include: ["src"],
      }),
    )
    run("vp", ["exec", "tsc", "-p", `${source}/tsconfig.vendor.json`])
    manifest.exports = manifest.publishConfig.exports
    manifest.gitHead = revision
    delete manifest.devDependencies
    delete manifest.scripts
    delete manifest.publishConfig
    if (manifest.peerDependencies?.effect) manifest.peerDependencies.effect = "4.0.0-rc.112"
    writeFileSync(`${packageDir}/package.json`, `${JSON.stringify(manifest, null, 2)}\n`)
    cpSync(`${temporary}/LICENSE`, `${packageDir}/LICENSE`)
    const file = `vendor/${name === "effect" ? "effect" : "effect-vitest"}-${revision}.tgz`
    run("tar", [
      "--sort=name",
      "--mtime=@0",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "-czf",
      file,
      "-C",
      `${temporary}/${name}`,
      "package",
    ])
    artifacts.push({ file, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") })
  }
  writeFileSync(
    "vendor/effect-artifacts.json",
    `${JSON.stringify({ revision, typescript: "7.0.2", artifacts }, null, 2)}\n`,
  )
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
