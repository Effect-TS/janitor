// Type-checks the runner's own sources against the vendored OpenCode source.
//
// The vendored packages are checked as part of this program because the runner
// imports their TypeScript directly, but upstream validates them with its own
// toolchain and devDependencies (Bun types, optional provider type packages).
// Diagnostics inside `vendor/` are therefore reported separately and do not
// fail the check; diagnostics in `src/` and `test/` do.
import { spawnSync } from "node:child_process"

const result = spawnSync("tsc", ["-p", "tsconfig.json", "--noEmit", "--pretty", "false"], {
  encoding: "utf8",
  shell: true,
})
const lines = (result.stdout + result.stderr).split("\n")
const own = []
let vendor = 0
let current = "own"
for (const line of lines) {
  const location = /^(\S+?)\(\d+,\d+\): error TS\d+/.exec(line)
  if (location) current = location[1].startsWith("vendor/") ? "vendor" : "own"
  if (line.trim() === "") continue
  if (current === "vendor") {
    if (location) vendor++
    continue
  }
  own.push(line)
}
if (vendor > 0)
  console.log(
    `Ignored ${vendor} upstream diagnostics under vendor/ (validated by upstream's toolchain).`,
  )
if (own.length > 0) {
  console.error(own.join("\n"))
  process.exit(1)
}
console.log("Runner sources type-check cleanly.")
