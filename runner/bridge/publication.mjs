import { spawn } from "node:child_process"
import {
  mkdtempSync,
  mkdirSync,
  lstatSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  rmSync,
  realpathSync,
} from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const oid = /^[a-f0-9]{40}$/
const refuse = (message) => {
  throw Object.assign(new Error(message), { status: 409 })
}
const checkFile = (path) => {
  if (!lstatSync(path).isFile()) refuse("Git metadata must be regular files")
}
const regular = (path) => {
  checkFile(path)
  return readFileSync(path)
}
const directory = (path) => {
  if (!lstatSync(path).isDirectory()) refuse("Git directory was replaced")
}
const branchName = (value) =>
  typeof value === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(value) &&
  !value.includes("..") &&
  !value.includes("//") &&
  value
    .split("/")
    .every(
      (part) => part && !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(".lock"),
    )

// Only regular object files enter the credential-bearing repository. In particular,
// source config, hooks, alternates, replace refs and credential helpers never do.
function copyObjects(source, target) {
  directory(source)
  directory(target)
  for (const name of readdirSync(source)) {
    if (!/^(?:[a-f0-9]{2}|pack)$/.test(name)) continue
    const from = join(source, name)
    directory(from)
    const to = join(target, name)
    if (!existsSync(to)) mkdirSync(to)
    directory(to)
    for (const file of readdirSync(from)) {
      if (
        !(name === "pack" ? /^pack-[a-f0-9]{40}\.(?:pack|idx|rev)$/ : /^[a-f0-9]{38}$/).test(file)
      )
        continue
      checkFile(join(from, file))
      if (existsSync(join(to, file))) {
        checkFile(join(to, file))
        continue
      }
      copyFileSync(join(from, file), join(to, file))
    }
  }
}

/** Runs with no untrusted process alive. The caller holds the bridge's workspace freeze. */
export async function publishGit(root, origin, action, input) {
  if (
    !/^[A-Za-z0-9_.-]+$/.test(input.owner ?? "") ||
    !/^[A-Za-z0-9_.-]+$/.test(input.repo ?? "") ||
    !/^janitor\/[a-f0-9]{64}$/.test(input.branch ?? "") ||
    !branchName(input.base) ||
    input.branch === input.base ||
    typeof input.token !== "string" ||
    !input.token
  )
    refuse("Invalid publication identity")
  const work = join(root, "repository")
  directory(work)
  const source = join(work, ".git")
  directory(source)
  const temp = mkdtempSync(join(tmpdir(), "janitor-git-"))
  const repo = join(temp, "repository.git")
  const url = `${origin}/${input.owner}/${input.repo}.git`
  let changedWorkspace = false
  const git = (args, credential = false, stdin) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "protocol.ext.allow=never",
          "-c",
          "protocol.file.allow=never",
          ...(origin.startsWith("/") ? ["-c", "protocol.file.allow=always"] : []),
          "-c",
          "credential.helper=",
          ...(credential
            ? [
                "-c",
                'credential.helper=!f() { printf "username=x-access-token\\npassword=%s\\n" "$JANITOR_GIT_TOKEN"; }; f',
              ]
            : []),
          ...args,
        ],
        {
          detached: true,
          stdio: ["pipe", "pipe", "ignore"],
          env: {
            PATH: process.env.PATH,
            HOME: "/nonexistent",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_TERMINAL_PROMPT: "0",
            GIT_NO_REPLACE_OBJECTS: "1",
            GIT_AUTHOR_NAME: "Janitor",
            GIT_AUTHOR_EMAIL: "janitor@users.noreply.github.com",
            GIT_COMMITTER_NAME: "Janitor",
            GIT_COMMITTER_EMAIL: "janitor@users.noreply.github.com",
            ...(credential ? { JANITOR_GIT_TOKEN: input.token } : {}),
          },
        },
      )
      const output = []
      let size = 0
      const kill = () => {
        try {
          process.kill(-child.pid, "SIGKILL")
        } catch {}
      }
      const timer = setTimeout(kill, 120000)
      child.stdout.on("data", (chunk) => {
        size += chunk.length
        if (size > 1048576) kill()
        else output.push(chunk)
      })
      child.stdin.on("error", () => {})
      child.stdin.end(stdin)
      child.once("error", () => {
        clearTimeout(timer)
        reject(new Error("Controlled Git unavailable"))
      })
      child.once("close", (code) => {
        clearTimeout(timer)
        resolve({ code, text: Buffer.concat(output).toString().trim() })
      })
    })
  const run = async (args, credential = false, stdin) => {
    const result = await git([`--git-dir=${repo}`, ...args], credential, stdin)
    if (result.code !== 0) refuse("Controlled Git failed; workspace preserved")
    return result.text
  }
  try {
    if ((await git(["init", "--bare", repo])).code !== 0) refuse("Cannot initialize controlled Git")
    copyObjects(join(source, "objects"), join(repo, "objects"))
    const refs = await run(
      ["ls-remote", "--heads", url, `refs/heads/${input.base}`, `refs/heads/${input.branch}`],
      true,
    )
    const remote = new Map(
      refs
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [sha, ref] = line.split(/\s+/)
          return [ref, sha]
        }),
    )
    const remoteHead = remote.get(`refs/heads/${input.branch}`) ?? null
    const baseCommit = remote.get(`refs/heads/${input.base}`)
    if (!baseCommit || !oid.test(baseCommit) || (remoteHead && !oid.test(remoteHead)))
      refuse("Publication base is unavailable")
    await run(
      [
        "fetch",
        "--no-tags",
        url,
        `refs/heads/${input.base}:refs/heads/base`,
        ...(remoteHead ? [`refs/heads/${input.branch}:refs/heads/remote`] : []),
      ],
      true,
    )
    // Use the fetched refs, since history may have moved after ls-remote.
    const fetchedBase = await run(["rev-parse", "refs/heads/base"])
    const fetchedHead = remoteHead ? await run(["rev-parse", "refs/heads/remote"]) : null
    const ancestor = async (a, b) =>
      (await git([`--git-dir=${repo}`, "merge-base", "--is-ancestor", a, b])).code === 0
    if (action === "inspect") {
      if (!oid.test(input.commit ?? "")) refuse("Invalid intended commit")
      return {
        remoteHead: fetchedHead,
        contains: !!fetchedHead && (await ancestor(input.commit, fetchedHead)),
      }
    }
    if (action === "push") {
      if (!oid.test(input.commit ?? "")) refuse("Invalid intended commit")
      await run(["cat-file", "-e", `${input.commit}^{commit}`])
      if (fetchedHead !== input.remoteHead) return { status: "stale" }
      if (fetchedHead && !(await ancestor(fetchedHead, input.commit))) return { status: "conflict" }
      // An explicit URL/refspec ignores mutable origin configuration. Normal push
      // rejects a human commit racing this check. There is no force-push path.
      const result = await git(
        [
          `--git-dir=${repo}`,
          "push",
          "--porcelain",
          url,
          `${input.commit}:refs/heads/${input.branch}`,
        ],
        true,
      )
      return { status: result.code === 0 ? "pushed" : "unconfirmed" }
    }
    if (action !== "prepare") refuse("Unknown Git operation")
    let head = regular(join(source, "HEAD")).toString().trim()
    if (head.startsWith("ref: refs/heads/")) {
      const ref = head.slice(5)
      if (!branchName(ref)) refuse("Invalid workspace branch")
      const path = join(source, ref)
      if (existsSync(path)) {
        if (!realpathSync(path).startsWith(source + "/")) refuse("Workspace ref escaped")
        head = regular(path).toString().trim()
      } else
        head =
          regular(join(source, "packed-refs"))
            .toString()
            .split("\n")
            .find((line) => line.endsWith(` ${ref}`))
            ?.split(" ")[0] ?? ""
    }
    if (!oid.test(head)) refuse("Commit repository work before publishing")
    await run(["cat-file", "-e", `${head}^{commit}`])
    if (existsSync(join(source, "index"))) {
      regular(join(source, "index"))
      copyFileSync(join(source, "index"), join(repo, "index"))
    } else await run(["read-tree", head])
    await git([`--git-dir=${repo}`, `--work-tree=${work}`, "update-index", "--refresh"])
    if (
      (await git([`--git-dir=${repo}`, `--work-tree=${work}`, "diff-index", "--quiet", head, "--"]))
        .code !== 0
    )
      refuse("Commit tracked edits before publishing; workspace preserved")
    let commit = head
    const originalIndex = regular(join(repo, "index"))
    const mergeWork = join(temp, "merge")
    mkdirSync(mergeWork)
    for (const incoming of [fetchedBase, fetchedHead].filter(Boolean)) {
      if (await ancestor(incoming, commit)) continue
      if (await ancestor(commit, incoming)) {
        commit = incoming
        continue
      }
      // Git 2.34 in the pinned Sandbox image predates merge-tree --write-tree.
      // Merge in a private worktree with no repository-provided config or hooks.
      await run([`--work-tree=${mergeWork}`, "read-tree", "--reset", "-u", commit])
      await run(["update-ref", "HEAD", commit])
      const merge = await git([
        `--git-dir=${repo}`,
        `--work-tree=${mergeWork}`,
        "-c",
        "core.bare=false",
        "merge",
        "--no-ff",
        "--no-edit",
        "--no-stat",
        incoming,
      ])
      if (merge.code !== 0)
        return {
          status: "conflict",
          message:
            "Human changes conflict with this work. Ask the teammate how to resolve them; no push was made.",
        }
      commit = await run(["rev-parse", "HEAD"])
    }
    changedWorkspace = true
    writeFileSync(join(repo, "index"), originalIndex)
    await run([`--work-tree=${work}`, "read-tree", "-m", "-u", head, commit])
    copyObjects(join(repo, "objects"), join(source, "objects"))
    const branchDir = join(source, "refs", "heads", "janitor")
    for (const path of [join(source, "refs"), join(source, "refs", "heads"), branchDir]) {
      if (!existsSync(path)) mkdirSync(path)
      directory(path)
    }
    for (const [path, contents] of [
      [join(source, "refs", "heads", input.branch), `${commit}\n`],
      [join(source, "HEAD"), `ref: refs/heads/${input.branch}\n`],
      [join(source, "index"), regular(join(repo, "index"))],
    ]) {
      if (existsSync(path)) regular(path)
      writeFileSync(path, contents)
    }
    return { status: "prepared", commit, baseCommit: fetchedBase, remoteHead: fetchedHead }
  } catch (error) {
    if (action === "prepare" && !changedWorkspace)
      return {
        status: "blocked",
        message:
          "Repository access or committed work is unavailable. Preserve edits, check access and commit tracked changes before retrying publish.",
      }
    throw error
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}
