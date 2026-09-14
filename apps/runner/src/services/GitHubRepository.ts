import { Context, Effect, Layer } from "effect"
import { ProtocolError } from "../Protocol.ts"
import type { RepositoryCredential } from "../Publication.ts"
import {
  gitBlobSha,
  MAX_FILE_BYTES,
  MAX_WORKSPACE_FILES,
  repositoryPath,
  type RepositoryFile,
} from "./WorkspaceStore.ts"

export const checkedSha = (value: unknown): string => {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value))
    throw new ProtocolError("blocked", "GitHub returned an invalid Git object identity")
  return value
}
export const branchPath = (branch: string) => {
  if (
    !branch ||
    branch.startsWith("/") ||
    branch.includes("..") ||
    /[\x00-\x20~^:?*[\\]/.test(branch)
  )
    throw new ProtocolError("invalid_request", "Invalid repository branch")
  return branch.split("/").map(encodeURIComponent).join("/")
}
const make = (send: (request: Request) => Promise<Response>, fence: () => Promise<void>) => {
  const request = (
    credential: RepositoryCredential,
    path: string,
    method = "GET",
    body?: unknown,
  ) =>
    Effect.tryPromise({
      try: async (signal) => {
        if (
          !/^[A-Za-z0-9_.-]+$/.test(credential.owner) ||
          !/^[A-Za-z0-9_.-]+$/.test(credential.repo) ||
          !credential.token
        )
          throw new ProtocolError("blocked", "Repository credentials are unavailable")
        await fence()
        const response = await send(
          new Request(
            `https://api.github.com/repos/${credential.owner}/${credential.repo}${path}`,
            {
              method,
              redirect: "manual",
              signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
              headers: {
                authorization: `Bearer ${credential.token}`,
                accept: "application/vnd.github+json",
                "content-type": "application/json",
                "user-agent": "Janitor",
                "x-github-api-version": "2022-11-28",
              },
              body: body === undefined ? undefined : JSON.stringify(body),
            },
          ),
        )
        await fence()
        return response
      },
      catch: (cause) =>
        cause instanceof ProtocolError
          ? cause
          : new ProtocolError("transport", "GitHub repository request failed"),
    })
  const json = <A>(
    credential: RepositoryCredential,
    path: string,
    method = "GET",
    body?: unknown,
  ): Effect.Effect<A, ProtocolError> =>
    request(credential, path, method, body).pipe(
      Effect.flatMap((response) =>
        Effect.tryPromise({
          try: async () => {
            if (!response.ok)
              throw new ProtocolError(
                [401, 403, 404, 409, 422].includes(response.status) ? "blocked" : "transport",
                `GitHub repository operation failed (${response.status})`,
              )
            return (await response.json()) as A
          },
          catch: (cause) =>
            cause instanceof ProtocolError
              ? cause
              : new ProtocolError("transport", "Invalid GitHub repository response"),
        }),
      ),
    )
  const commit = (credential: RepositoryCredential, sha: string) =>
    json<{ sha: string; tree: { sha: string }; parents: Array<{ sha: string }> }>(
      credential,
      `/git/commits/${checkedSha(sha)}`,
    )
  const ref = (credential: RepositoryCredential, branch: string) =>
    request(credential, `/git/ref/heads/${branchPath(branch)}`).pipe(
      Effect.flatMap((response) =>
        Effect.tryPromise({
          try: async () => {
            if (response.status === 404 || response.status === 409) return null
            if (!response.ok)
              throw new ProtocolError("blocked", `GitHub branch lookup failed (${response.status})`)
            const result = (await response.json()) as {
              ref: string
              object: { type: string; sha: string }
            }
            if (result.ref !== `refs/heads/${branch}` || result.object?.type !== "commit")
              throw new ProtocolError("blocked", "GitHub branch identity changed")
            return checkedSha(result.object.sha)
          },
          catch: (cause) =>
            cause instanceof ProtocolError
              ? cause
              : new ProtocolError("transport", "Invalid GitHub branch response"),
        }),
      ),
    )
  const tree = (credential: RepositoryCredential, sha: string) =>
    Effect.gen(function* () {
      type Entry = { path: string; sha: string; mode: string; type: string; size?: number }
      type Tree = { sha: string; truncated: boolean; tree: Entry[] }
      const root = yield* json<Tree>(credential, `/git/trees/${checkedSha(sha)}?recursive=1`)
      const entries: RepositoryFile[] = []
      const add = (entry: Entry, prefix: string) => {
        if (entry.type !== "blob" && entry.type !== "commit") return
        entries.push({
          path: repositoryPath(prefix + entry.path),
          sha: checkedSha(entry.sha),
          mode: entry.mode,
          type: entry.type,
          size: entry.size,
        })
        if (entries.length > MAX_WORKSPACE_FILES)
          throw new ProtocolError("blocked", "Repository exceeds the 20,000-file workspace limit")
      }
      if (!Array.isArray(root.tree))
        return yield* Effect.fail(new ProtocolError("blocked", "Invalid GitHub tree"))
      if (!root.truncated) {
        for (const entry of root.tree) add(entry, "")
        return entries
      }
      // Never treat a truncated recursive tree as a complete checkout.
      const queue = [{ sha, prefix: "" }]
      let requests = 0
      while (queue.length) {
        if (++requests > 1000)
          return yield* Effect.fail(
            new ProtocolError("blocked", "Repository tree traversal limit reached"),
          )
        const next = queue.shift()!
        const result = yield* json<Tree>(credential, `/git/trees/${checkedSha(next.sha)}`)
        if (result.truncated || !Array.isArray(result.tree))
          return yield* Effect.fail(
            new ProtocolError("blocked", "GitHub returned an incomplete repository directory"),
          )
        for (const entry of result.tree) {
          if (entry.type === "tree")
            queue.push({
              sha: checkedSha(entry.sha),
              prefix: repositoryPath(next.prefix + entry.path) + "/",
            })
          else add(entry, next.prefix)
        }
      }
      return entries
    })
  return {
    request,
    json,
    commit,
    ref,
    tree,
    metadata: (credential: RepositoryCredential) =>
      json<{ id: number; default_branch: string }>(credential, ""),
    blob: (credential: RepositoryCredential, sha: string) =>
      Effect.gen(function* () {
        const result = yield* json<{
          sha: string
          encoding: string
          content: string
          size: number
        }>(credential, `/git/blobs/${checkedSha(sha)}`)
        if (
          result.sha !== sha ||
          result.encoding !== "base64" ||
          !Number.isSafeInteger(result.size) ||
          result.size > MAX_FILE_BYTES ||
          result.size < 0
        )
          return yield* Effect.fail(
            new ProtocolError("blocked", "GitHub blob is invalid or exceeds the 1 MiB file limit"),
          )
        const bytes = Uint8Array.from(atob(result.content.replace(/\s/g, "")), (value) =>
          value.charCodeAt(0),
        )
        if (
          bytes.length !== result.size ||
          (yield* Effect.promise(() => gitBlobSha(bytes))) !== sha
        )
          return yield* Effect.fail(
            new ProtocolError("blocked", "GitHub blob checksum differs from its tree identity"),
          )
        return bytes
      }),
    contains: (credential: RepositoryCredential, ancestor: string, head: string) =>
      ancestor === head
        ? Effect.succeed(true)
        : json<{ status: string }>(
            credential,
            `/compare/${checkedSha(ancestor)}...${checkedSha(head)}`,
          ).pipe(
            Effect.map((result) => result.status === "ahead" || result.status === "identical"),
          ),
  }
}

export class GitHubRepository extends Context.Service<GitHubRepository, ReturnType<typeof make>>()(
  "janitor/runner/GitHubRepository",
) {
  static make = make
  static layer(send: (request: Request) => Promise<Response>, fence: () => Promise<void>) {
    return Layer.sync(this, () => make(send, fence))
  }
}
