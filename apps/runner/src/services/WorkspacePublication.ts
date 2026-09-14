import { Context, Effect, Layer } from "effect"
import { ProtocolError } from "../Protocol.ts"
import type { CredentialPermission, RepositoryCredential } from "../Publication.ts"
import { branchPath, checkedSha, GitHubRepository } from "./GitHubRepository.ts"
import { WorkspaceStore, type FileEntry } from "./WorkspaceStore.ts"

interface Dependencies {
  storage: DurableObjectStorage
  files: WorkspaceStore["Service"]
  github: GitHubRepository["Service"]
  authorize: (permission: CredentialPermission) => Promise<RepositoryCredential>
  fence: () => Promise<void>
}
interface GitOperation {
  branch: string
  base: string
  prepareId?: string
  title?: string
  existing?: boolean
  commit?: string
  remoteHead?: string | null
}
interface Prepared {
  revision: number
  branch: string
  base: string
  date: string
  message: string
  parent: string
  baseCommit: string
  remoteHead: string | null
  commit?: string
  tree?: string
  changes: FileEntry[]
}
const make = ({ storage, files, github, authorize, fence }: Dependencies) => {
  const run = Effect.runPromise
  const save = async (key: string, value: Prepared) => {
    if (new TextEncoder().encode(JSON.stringify(value)).length > 100000)
      throw new ProtocolError(
        "blocked",
        "Publication metadata exceeds 100 KB; reduce the number or length of changed paths",
      )
    await fence()
    await storage.put(key, value)
    await storage.sync()
  }
  const prepare = async (input: GitOperation) => {
    if (!input.prepareId)
      throw new ProtocolError("invalid_request", "Publication preparation identity is required")
    const key = `_janitor_git_prepare:${input.prepareId}`
    let prepared = await storage.get<Prepared>(key)
    const state = files.state()
    if (!state) throw new ProtocolError("blocked", "Repository workspace is not ready")
    if (
      prepared &&
      (prepared.branch !== input.branch ||
        prepared.base !== input.base ||
        prepared.revision !== state.revision)
    )
      throw new ProtocolError("blocked", "Workspace changed during publication preparation")
    if (prepared?.commit) return { status: "prepared", ...prepared }
    const credential = await authorize("push")
    if (!prepared) {
      const baseCommit = await run(github.ref(credential, input.base))
      if (!baseCommit)
        throw new ProtocolError(
          "blocked",
          "Publication requires an initialized base branch; workspace edits are preserved",
        )
      const remoteHead = await run(github.ref(credential, input.branch))
      if (input.existing && !remoteHead)
        throw new ProtocolError(
          "blocked",
          "The existing PR branch was deleted; workspace edits are preserved",
        )
      const parent = remoteHead ?? baseCommit
      const remoteCommit = await run(github.commit(credential, parent))
      const remote = new Map(
        (await run(github.tree(credential, remoteCommit.tree.sha))).map((file) => [
          file.path,
          file,
        ]),
      )
      const changes = files
        .files()
        .filter(
          (file) =>
            file.dirty && (file.deleted ? file.base_sha !== null : file.work_sha !== file.base_sha),
        )
      if (changes.length > 500)
        throw new ProtocolError(
          "blocked",
          "Publish at most 500 changed files at once; workspace edits are preserved",
        )
      for (const change of changes) {
        const current = remote.get(change.path)
        const remoteSha = current?.sha ?? null
        const desired = change.deleted ? null : change.work_sha
        if (remoteSha !== change.base_sha && remoteSha !== desired)
          return {
            status: "conflict",
            message: `Human changes overlap ${change.path}. Ask the teammate to resolve the conflict; edits are preserved.`,
          }
        if (current && current.mode !== change.mode)
          return {
            status: "conflict",
            message: `Human changes altered the file mode at ${change.path}. Ask the teammate before publishing.`,
          }
      }
      prepared = {
        revision: state.revision,
        branch: input.branch,
        base: input.base,
        date: new Date().toISOString(),
        message: input.title ?? "Janitor repository changes",
        parent,
        baseCommit,
        remoteHead,
        tree: checkedSha(remoteCommit.tree.sha),
        changes: changes.filter((change) =>
          change.deleted
            ? remote.has(change.path)
            : remote.get(change.path)?.sha !== change.work_sha,
        ),
      }
      await save(key, prepared)
    }
    // Git objects are content-addressed. Persisted author/date/payload make retries identical.
    for (const change of prepared.changes) {
      if (change.deleted) continue
      const bytes = files.blob(change.work_sha!)
      if (!bytes) throw new ProtocolError("blocked", "Prepared file content is missing")
      let binary = ""
      for (const byte of bytes) binary += String.fromCharCode(byte)
      const blob = await run(
        github.json<{ sha: string }>(credential, "/git/blobs", "POST", {
          content: btoa(binary),
          encoding: "base64",
        }),
      )
      if (blob.sha !== change.work_sha)
        throw new ProtocolError(
          "blocked",
          "Published Git blob identity differs from the prepared edit",
        )
    }
    const tree = prepared.changes.length
      ? checkedSha(
          (
            await run(
              github.json<{ sha: string }>(credential, "/git/trees", "POST", {
                base_tree: prepared.tree,
                tree: prepared.changes.map((file) => ({
                  path: file.path,
                  mode: file.mode,
                  type: "blob",
                  sha: file.deleted ? null : file.work_sha,
                })),
              }),
            )
          ).sha,
        )
      : prepared.tree!
    const author = {
      name: "Janitor",
      email: "janitor@users.noreply.github.com",
      date: prepared.date,
    }
    const commit = prepared.changes.length
      ? checkedSha(
          (
            await run(
              github.json<{ sha: string }>(credential, "/git/commits", "POST", {
                message: prepared.message,
                tree,
                parents: [prepared.parent],
                author,
                committer: author,
              }),
            )
          ).sha,
        )
      : prepared.parent
    prepared = { ...prepared, commit, tree }
    await save(key, prepared)
    await save(`_janitor_git_commit:${commit}`, prepared)
    return {
      status: "prepared",
      commit,
      baseCommit: prepared.baseCommit,
      remoteHead: prepared.remoteHead,
    }
  }
  const push = async (input: GitOperation) => {
    const credential = await authorize("push")
    const commit = checkedSha(input.commit)
    const current = await run(github.ref(credential, input.branch))
    if (current && (await run(github.contains(credential, commit, current))))
      return { status: "pushed" }
    if (current !== input.remoteHead) return { status: "stale" }
    const response =
      current === null
        ? await run(
            github.request(credential, "/git/refs", "POST", {
              ref: `refs/heads/${input.branch}`,
              sha: commit,
            }),
          )
        : await run(
            github.request(credential, `/git/refs/heads/${branchPath(input.branch)}`, "PATCH", {
              sha: commit,
              force: false,
            }),
          )
    if (response.ok) return { status: "pushed" }
    if (response.status === 409 || response.status === 422) return { status: "stale" }
    if ([400, 401, 403, 404, 429].includes(response.status)) return { status: "unconfirmed" }
    throw new ProtocolError(
      "transport",
      "GitHub reference update outcome is unknown; reconcile the same commit",
    )
  }
  const inspect = async (input: GitOperation) => {
    const credential = await authorize("read")
    const commit = checkedSha(input.commit)
    const remoteHead = await run(github.ref(credential, input.branch))
    const contains =
      remoteHead !== null && (await run(github.contains(credential, commit, remoteHead)))
    if (contains) {
      const prepared = await storage.get<Prepared>(`_janitor_git_commit:${commit}`)
      const state = files.state()
      if (prepared && state && state.revision === prepared.revision) {
        const remoteCommit = await run(github.commit(credential, remoteHead!))
        const entries = await run(github.tree(credential, remoteCommit.tree.sha))
        await fence()
        files.initialize(
          { ...state, commit: remoteHead, tree: remoteCommit.tree.sha, branch: input.branch },
          entries,
        )
      }
    }
    return { contains, remoteHead }
  }
  return {
    execute: (action: string, input: unknown) =>
      Effect.tryPromise({
        try: async (): Promise<unknown> => {
          const operation = input as GitOperation
          branchPath(operation.branch)
          if (action === "prepare") return prepare(operation)
          if (action === "push") return push(operation)
          if (action === "inspect") return inspect(operation)
          throw new ProtocolError("invalid_request", "Unknown repository publication operation")
        },
        catch: (cause) => cause,
      }),
  }
}
export class WorkspacePublication extends Context.Service<
  WorkspacePublication,
  ReturnType<typeof make>
>()("janitor/runner/WorkspacePublication") {
  static make = make
  static layer(deps: Dependencies) {
    return Layer.sync(this, () => make(deps))
  }
}
