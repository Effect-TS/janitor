import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startBridge } from "./server.mjs"
import { randomUUID } from "node:crypto"

test("controlled publication creates the designated branch and incorporates concurrent human commits", async () => {
  const root = mkdtempSync(join(tmpdir(), "janitor-publication-"))
  const git = (cwd, ...args) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.com",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.com",
      },
    }).trim()
  const origin = join(root, "remote")
  mkdirSync(join(origin, "owner"), { recursive: true })
  git(root, "init", "--bare", "--initial-branch=main", `${origin}/owner/repo.git`)
  git(root, "clone", `${origin}/owner/repo.git`, "human")
  const human = join(root, "human")
  writeFileSync(join(human, "README.md"), "base\n")
  git(human, "add", ".")
  git(human, "commit", "-m", "base")
  git(human, "push", "origin", "main")
  const cwd = join(root, "workspace")
  mkdirSync(cwd)
  const journalPath = join(root, "journal.sqlite")
  const bridge = await startBridge({
    token: "bridge",
    generation: 1,
    cwd,
    journalPath,
    isolateProcesses: false,
    cloneOrigin: origin,
  })
  const call = async (path, input) => {
    if (path === "/git/prepare") input = { prepareId: randomUUID(), ...input }
    const response = await fetch(bridge.url + path, {
      method: "POST",
      headers: {
        authorization: "Bearer bridge",
        "x-janitor-generation": "1",
        "x-bridge-epoch": bridge.epoch,
      },
      body: JSON.stringify(input),
    })
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    return body
  }
  try {
    await call("/clone", { owner: "owner", repo: "repo", token: "short-lived-secret" })
    const work = join(cwd, "repository")
    writeFileSync(join(work, "agent.txt"), "agent work\n")
    git(work, "add", ".")
    git(work, "commit", "-m", "agent work")
    const original = git(work, "rev-parse", "HEAD")
    git(work, "config", "credential.helper", `!echo leaked > ${root}/leaked`)
    git(work, "config", "remote.origin.pushurl", "/not-the-designated-repository")
    const input = {
      owner: "owner",
      repo: "repo",
      token: "short-lived-secret",
      branch: `janitor/${"a".repeat(64)}`,
      base: "main",
    }
    const prepared = await call("/git/prepare", input)
    assert.equal(prepared.commit, original)
    assert.equal(prepared.remoteHead, null)
    assert.equal((await call("/git/push", { ...input, ...prepared })).status, "pushed")
    assert.equal((await call("/git/inspect", { ...input, commit: original })).contains, true)
    git(human, "fetch", "origin")
    git(human, "checkout", "-b", input.branch, `origin/${input.branch}`)
    writeFileSync(join(human, "human.txt"), "human work\n")
    git(human, "add", ".")
    git(human, "commit", "-m", "human work")
    git(human, "push", "origin", input.branch)
    const humanCommit = git(human, "rev-parse", "HEAD")
    writeFileSync(join(work, "agent.txt"), "more agent work\n")
    git(work, "add", ".")
    git(work, "commit", "-m", "more agent work")
    const next = await call("/git/prepare", input)
    assert.equal(next.remoteHead, humanCommit)
    assert.equal(readFileSync(join(work, "human.txt"), "utf8"), "human work\n")
    assert.equal((await call("/git/push", { ...input, ...next })).status, "pushed")
    assert.equal(git(work, "merge-base", "--is-ancestor", humanCommit, next.commit), "")
    // A human push between prepare and push is refused, then fetched on retry.
    git(human, "pull", "--ff-only", "origin", input.branch)
    writeFileSync(join(human, "human.txt"), "later human work\n")
    git(human, "add", ".")
    git(human, "commit", "-m", "racing human")
    git(human, "push", "origin", input.branch)
    assert.equal(
      (await call("/git/push", { ...input, ...next, remoteHead: next.commit })).status,
      "stale",
    )
    const reconciled = await call("/git/prepare", input)
    assert.equal((await call("/git/push", { ...input, ...reconciled })).status, "pushed")
    git(human, "pull", "--ff-only", "origin", input.branch)
    writeFileSync(join(human, "agent.txt"), "human decision\n")
    git(human, "add", ".")
    git(human, "commit", "-m", "human decision")
    git(human, "push", "origin", input.branch)
    writeFileSync(join(work, "agent.txt"), "agent decision\n")
    git(work, "add", ".")
    git(work, "commit", "-m", "agent decision")
    const conflict = await call("/git/prepare", input)
    assert.equal(conflict.status, "conflict")
    assert.match(conflict.message, /Ask the teammate/)
    assert.equal(readFileSync(join(work, "agent.txt"), "utf8"), "agent decision\n")
    writeFileSync(join(work, "agent.txt"), "human decision\n")
    git(work, "add", ".")
    git(work, "commit", "-m", "Resolve with teammate decision")
    const resolved = await call("/git/prepare", input)
    assert.equal(resolved.status, "prepared")
    const hook = `${origin}/owner/repo.git/hooks/pre-receive`
    writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 })
    assert.equal((await call("/git/push", { ...input, ...resolved })).status, "unconfirmed")
    assert.equal(
      (await call("/git/inspect", { ...input, commit: resolved.commit })).contains,
      false,
    )
    rmSync(hook)
    assert.equal((await call("/git/push", { ...input, ...resolved })).status, "pushed")
    assert.throws(() => readFileSync(join(root, "leaked")), /ENOENT/)
    assert.ok(!readFileSync(join(work, ".git/config"), "utf8").includes("short-lived-secret"))
    assert.ok(!readFileSync(journalPath).includes(Buffer.from("short-lived-secret")))
  } finally {
    await bridge.close()
    rmSync(root, { recursive: true, force: true })
  }
})
