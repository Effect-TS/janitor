import { execFileSync } from "node:child_process"
import { readFileSync, readdirSync, lstatSync, readlinkSync } from "node:fs"
import { createHash } from "node:crypto"
const cwd = "/workspace/fixture"
const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" })
const files = {}
function walk(dir = "") {
  for (const name of readdirSync(`${cwd}/${dir}`).sort()) {
    if (!dir && name === ".git") continue
    const relative = dir ? `${dir}/${name}` : name
    const path = `${cwd}/${relative}`
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) files[relative] = { symlink: readlinkSync(path) }
    else if (stat.isDirectory()) walk(relative)
    else
      files[relative] = {
        mode: stat.mode & 0o777,
        size: stat.size,
        sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
      }
  }
}
walk()
console.log(
  JSON.stringify({
    head: git("rev-parse", "HEAD"),
    branch: git("branch", "--show-current"),
    status: git("status", "--porcelain=v1", "--untracked-files=all"),
    staged: git("diff", "--cached", "--binary"),
    unstaged: git("diff", "--binary"),
    files,
  }),
)
