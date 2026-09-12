import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  symlinkSync,
  readlinkSync,
  statSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// This is a host Git/archive baseline, not a Cloudflare or OpenCode adapter test.
const root = mkdtempSync(join(tmpdir(), "janitor-repository-fixture-"))
const checks = []
function run(cwd, command, args, expected = 0) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  })
  if (result.error) throw result.error
  assert.equal(result.status, expected, `${command} ${args.join(" ")}: ${result.stderr}`)
  return result.stdout
}
const git = (cwd, ...args) => run(cwd, "git", args)
function identify(path) {
  git(path, "config", "user.name", "Janitor Fixture")
  git(path, "config", "user.email", "fixture@example.invalid")
}
const upstream = join(root, "upstream.git")
const work = join(root, "workspace")
git(root, "init", "--bare", "--initial-branch=main", upstream)
git(root, "clone", upstream, work)
identify(work)
writeFileSync(join(work, ".gitignore"), "required.local\ncache/\n")
writeFileSync(join(work, "post.md"), "# Draft\nOriginal paragraph.\n")
writeFileSync(join(work, "remove.md"), "Delete this tracked file.\n")
writeFileSync(
  join(work, "check.mjs"),
  "import assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\nassert.match(readFileSync('post.md', 'utf8'), /^# Draft/m);\n",
)
git(work, "add", ".")
git(work, "commit", "-m", "Fixture baseline")
git(work, "push", "origin", "main")
git(work, "checkout", "-b", "janitor/fixture")
writeFileSync(join(work, "local-commit.md"), "Unpublished commit.\n")
git(work, "add", "local-commit.md")
git(work, "commit", "-m", "Unpublished fixture commit")
writeFileSync(join(work, "post.md"), "# Draft\nStaged edit.\n")
git(work, "add", "post.md")
writeFileSync(join(work, "post.md"), "# Draft\nStaged edit.\nUnstaged edit.\n")
git(work, "rm", "remove.md")
writeFileSync(join(work, "untracked.md"), "Untracked feedback.\n")
writeFileSync(join(work, "required.local"), "Required ignored state, no credentials.\n")
mkdirSync(join(work, "cache"))
writeFileSync(join(work, "cache", "rebuildable"), "Disposable.\n")
writeFileSync(join(work, "executable.sh"), "#!/bin/sh\nexit 0\n")
chmodSync(join(work, "executable.sh"), 0o755)
symlinkSync("post.md", join(work, "post-link"))
run(work, process.execPath, ["check.mjs"])
checks.push("fixture command succeeds with unfinished work")
function state(path) {
  return {
    head: git(path, "rev-parse", "HEAD"),
    branch: git(path, "branch", "--show-current"),
    status: git(path, "status", "--porcelain=v1", "--untracked-files=all"),
    staged: git(path, "diff", "--cached", "--binary"),
    unstaged: git(path, "diff", "--binary"),
    ignored: readFileSync(join(path, "required.local"), "utf8"),
    untracked: readFileSync(join(path, "untracked.md"), "utf8"),
    symlink: readlinkSync(join(path, "post-link")),
    executable: statSync(join(path, "executable.sh")).mode & 0o777,
  }
}
const before = state(work)
writeFileSync(join(root, "expected-state.json"), JSON.stringify(before, null, 2))
const archive = join(root, "host-baseline.tar")
run(root, "tar", ["--exclude=./cache", "-cf", archive, "-C", work, "."])
const restored = join(root, "restored")
mkdirSync(restored)
run(root, "tar", ["-xf", archive, "-C", restored])
assert.deepEqual(state(restored), before)
run(restored, process.execPath, ["check.mjs"])
checks.push(
  "host archive preserves index, local commit, tracked deletion, untracked and ignored files, symlink and mode",
)

// Publish to a local bare repository only. Simulate a human racing the next push.
git(restored, "add", "-A")
git(restored, "commit", "-m", "Implement feedback")
git(restored, "push", "origin", "janitor/fixture")
const human = join(root, "human")
git(root, "clone", "--branch", "janitor/fixture", upstream, human)
identify(human)
writeFileSync(join(human, "human.md"), "Concurrent human contribution.\n")
git(human, "add", "human.md")
git(human, "commit", "-m", "Human contribution")
git(human, "push", "origin", "janitor/fixture")
writeFileSync(join(restored, "agent.md"), "Further agent contribution.\n")
git(restored, "add", "agent.md")
git(restored, "commit", "-m", "Agent contribution")
run(restored, "git", ["push", "origin", "janitor/fixture"], 1)
git(restored, "fetch", "origin")
git(restored, "rebase", "origin/janitor/fixture")
assert.equal(readFileSync(join(restored, "human.md"), "utf8"), "Concurrent human contribution.\n")
git(restored, "push", "origin", "janitor/fixture")
checks.push("non-fast-forward push is rejected; reconciliation preserves concurrent human commit")
const intendedHead = git(restored, "rev-parse", "HEAD").trim()
const observedHead = git(restored, "ls-remote", "origin", "refs/heads/janitor/fixture").split(
  /\s/,
)[0]
assert.equal(observedHead, intendedHead)
checks.push("remote ref inspection observes successful local publication without a repeat push")
const report = {
  kind: "host-baseline-only",
  root,
  checks,
  cloudflareTested: false,
  openCodeAdapterTested: false,
  githubTested: false,
}
writeFileSync(join(root, "result.json"), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
