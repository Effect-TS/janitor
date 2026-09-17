import { assert, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { makeSandboxLocal } from "@janitor/alchemy/AI/SandboxLocal"
import * as Workspace from "@janitor/alchemy/Workspace/Workspace"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Effect from "effect/Effect"
import { makeReviewWorkspace } from "../../src/Review/Workspace.ts"

/**
 * The workspace provisions a specific commit from a remote with Git inside
 * the sandbox and only offers inspection over it. A local bare repository
 * stands in for GitHub; it is configured to serve any reachable commit, as
 * GitHub does.
 */

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim()

/** A bare remote with two commits; returns the URL and both commit ids. */
const remote = () => {
  const root = mkdtempSync(join(tmpdir(), "janitor-review-remote-"))
  const source = join(root, "source")
  const bare = join(root, "remote.git")
  git(root, "init", "-q", "-b", "main", source)
  writeFileSync(join(source, "README.md"), "# Demo\n\nfirst edition\n")
  writeFileSync(join(source, "index.js"), "export const answer = 41\n")
  git(source, "add", ".")
  git(source, "commit", "-q", "-m", "first")
  const first = git(source, "rev-parse", "HEAD")
  writeFileSync(join(source, "index.js"), "export const answer = 42\n")
  git(source, "commit", "-q", "-am", "second")
  const second = git(source, "rev-parse", "HEAD")
  git(root, "clone", "-q", "--bare", source, bare)
  git(bare, "config", "uploadpack.allowAnySHA1InWant", "true")
  return { url: `file://${bare}`, first, second }
}

const workspace = Effect.gen(function* () {
  const root = mkdtempSync(join(tmpdir(), "janitor-review-workspace-"))
  const sandbox = yield* makeSandboxLocal.pipe(Effect.provide(Workspace.fixed(root)))
  return { sandbox, review: makeReviewWorkspace(sandbox) }
}).pipe(Effect.provide(NodeServices.layer))

it.live("provisions the recorded commit without credentials and inspects it", () =>
  Effect.gen(function* () {
    const { url, first, second } = remote()
    const { review, sandbox } = yield* workspace
    assert.deepStrictEqual(yield* review.status, { _tag: "Absent" })
    const provisioned = yield* review.provision({ remoteUrl: url, commitSha: first })
    assert.deepStrictEqual(provisioned, { _tag: "Provisioned" })
    assert.deepStrictEqual(yield* review.status, { _tag: "Ready", commitSha: first })
    // The first commit, not the branch head, is checked out.
    assert.strictEqual(yield* review.readFile("index.js"), "1: export const answer = 41\n2: ")
    assert.include(yield* review.listFiles("."), "file README.md")
    assert.notInclude(yield* review.listFiles("."), ".git")
    assert.include(yield* review.search("answer", "."), "index.js:1:")
    assert.strictEqual(yield* review.search("nothing-here"), "(no matches)")
    const window = yield* review.readFile("README.md", { offset: 3, limit: 1 })
    assert.strictEqual(window, "3: first edition\n[1 more lines; read from offset 4]")
    // Provisioning the same commit again is a no-op; a pending marker is replaced.
    assert.deepStrictEqual(yield* review.provision({ remoteUrl: url, commitSha: first }), {
      _tag: "Provisioned",
    })
    // No credential helper or token ever reached the checkout's configuration.
    const config = yield* sandbox.readFile(".git/config")
    assert.notInclude(config, "extraHeader")
    assert.notInclude(config, "Authorization")
    // A different commit for the same run replaces the checkout.
    assert.deepStrictEqual(yield* review.provision({ remoteUrl: url, commitSha: second }), {
      _tag: "Provisioned",
    })
    assert.strictEqual(
      yield* review.readFile("index.js", { limit: 1 }),
      "1: export const answer = 42\n[1 more lines; read from offset 2]",
    )
    yield* review.release
    assert.deepStrictEqual(yield* review.status, { _tag: "Absent" })
    assert.deepStrictEqual(yield* sandbox.listFiles("."), [])
  }),
)

it.live("refuses a foreign workspace and reports an unreachable commit", () =>
  Effect.gen(function* () {
    const { url } = remote()
    const { review, sandbox } = yield* workspace
    yield* sandbox.writeFile("stray.txt", "someone else's file")
    const busy = yield* review.provision({ remoteUrl: url, commitSha: "a".repeat(40) })
    assert.strictEqual(busy._tag, "Failed")
    yield* sandbox.deleteFile("stray.txt")
    const missing = yield* review.provision({ remoteUrl: url, commitSha: "a".repeat(40) })
    assert.strictEqual(missing._tag, "Failed")
    assert.include(missing._tag === "Failed" ? missing.reason : "", "git fetch")
    // A failed provisioning leaves no ready marker behind.
    assert.deepStrictEqual(yield* review.status, { _tag: "Absent" })
  }),
)
