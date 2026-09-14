import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { execFileSync, spawn } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { startBridge } from "./server.mjs"

for (const selection of ["empty", "default", "branch", "pull-request"])
  test(`controlled ${selection} checkout fetches only the selected tip without saving credentials`, async () => {
    const root = mkdtempSync(join(tmpdir(), "janitor-clone-"))
    const remote = join(root, "remote")
    mkdirSync(join(remote, "test"), { recursive: true })
    execFileSync("git", ["init", "--bare", join(remote, "test", "example.git")], {
      stdio: "ignore",
    })
    const runGit = (cwd, ...args) =>
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
    let ancestor, feature, main
    if (selection !== "empty") {
      const seed = join(root, "seed")
      runGit(root, "clone", join(remote, "test", "example.git"), seed)
      runGit(seed, "checkout", "-b", "main")
      writeFileSync(join(seed, "README.md"), "first\n")
      runGit(seed, "add", ".")
      runGit(seed, "commit", "-m", "first")
      ancestor = runGit(seed, "rev-parse", "HEAD")
      runGit(seed, "checkout", "-b", "feature")
      writeFileSync(join(seed, "README.md"), "feature tip\n")
      runGit(seed, "commit", "-am", "feature")
      feature = runGit(seed, "rev-parse", "HEAD")
      runGit(seed, "push", "origin", "feature", "HEAD:refs/pull/7/head")
      runGit(seed, "checkout", "main")
      writeFileSync(join(seed, "README.md"), "main tip\n")
      runGit(seed, "commit", "-am", "main")
      main = runGit(seed, "rev-parse", "HEAD")
      runGit(seed, "tag", "unneeded-tag")
      runGit(seed, "push", "origin", "main", "--tags")
      runGit(join(remote, "test", "example.git"), "symbolic-ref", "HEAD", "refs/heads/main")
      if (selection === "pull-request") runGit(seed, "push", "origin", "--delete", "feature")
    }
    let authorized = 0
    const git = createServer((req, res) => {
      if (
        req.headers.authorization !==
        `Basic ${Buffer.from("x-access-token:private-test-token").toString("base64")}`
      ) {
        res.writeHead(401, { "www-authenticate": 'Basic realm="fixture"' })
        res.end()
        return
      }
      authorized++
      const url = new URL(req.url, "http://localhost")
      const child = spawn("git", ["http-backend"], {
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: remote,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: req.method,
          CONTENT_TYPE: req.headers["content-type"] ?? "",
          REMOTE_USER: "fixture",
        },
        stdio: ["pipe", "pipe", "ignore"],
      })
      req.pipe(child.stdin)
      const chunks = []
      child.stdout.on("data", (chunk) => chunks.push(chunk))
      child.on("close", () => {
        const output = Buffer.concat(chunks)
        const boundary = output.indexOf("\r\n\r\n")
        const headers = Object.fromEntries(
          output
            .subarray(0, boundary)
            .toString()
            .split("\r\n")
            .map((line) => {
              const index = line.indexOf(":")
              return [line.slice(0, index), line.slice(index + 1).trim()]
            }),
        )
        res.writeHead(200, headers)
        res.end(output.subarray(boundary + 4))
      })
    })
    await new Promise((resolve) => git.listen(0, "127.0.0.1", resolve))
    const cwd = join(root, "workspace")
    mkdirSync(cwd)
    const journalPath = join(root, "operations.sqlite")
    const bridge = await startBridge({
      token: "bridge-token",
      generation: 1,
      cwd,
      journalPath,
      isolateProcesses: false,
      cloneOrigin: `http://127.0.0.1:${git.address().port}`,
    })
    const clone = async (token) => {
      const response = await fetch(bridge.url + "/clone", {
        method: "POST",
        headers: {
          authorization: "Bearer bridge-token",
          "x-janitor-generation": "1",
          "x-bridge-epoch": bridge.epoch,
        },
        body: JSON.stringify({
          owner: "test",
          repo: "example",
          token,
          ...(selection === "default" || selection === "empty" ? {} : { branch: "feature" }),
          ...(selection === "pull-request" ? { pullRequestNumber: 7 } : {}),
        }),
      })
      return { status: response.status, body: await response.json() }
    }
    try {
      assert.equal((await clone("private-test-token")).status, 200)
      assert.ok(authorized > 0)
      const work = join(cwd, "repository")
      if (selection === "empty") {
        assert.equal(runGit(work, "status", "--porcelain"), "")
        assert.throws(() => runGit(work, "rev-parse", "HEAD"))
      } else {
        assert.equal(runGit(work, "rev-parse", "HEAD"), selection === "default" ? main : feature)
        assert.equal(runGit(work, "rev-list", "--count", "HEAD"), "1")
        assert.equal(runGit(work, "rev-parse", "--is-shallow-repository"), "true")
        assert.equal(runGit(work, "tag", "--list"), "")
        assert.equal(
          readFileSync(join(work, "README.md"), "utf8"),
          selection === "default" ? "main tip\n" : "feature tip\n",
        )
        assert.throws(() => runGit(work, "cat-file", "-e", ancestor))
        assert.throws(() =>
          runGit(work, "cat-file", "-e", selection === "default" ? feature : main),
        )
      }
      const count = authorized
      assert.equal((await clone("different-token")).body.duplicate, true)
      assert.equal(authorized, count)
      const config = readFileSync(join(cwd, "repository/.git/config"), "utf8")
      assert.ok(!config.includes("credential"))
      const visit = (directory) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name)
          if (entry.isDirectory()) visit(path)
          else assert.ok(!readFileSync(path).includes(Buffer.from("private-test-token")), path)
        }
      }
      visit(cwd)
      assert.ok(!readFileSync(journalPath).includes(Buffer.from("private-test-token")))
    } finally {
      await bridge.close()
      git.closeAllConnections()
      await new Promise((resolve) => git.close(resolve))
      rmSync(root, { recursive: true, force: true })
    }
  })
