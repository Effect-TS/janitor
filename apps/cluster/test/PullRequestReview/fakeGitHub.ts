import { parseTrustedDiff } from "@janitor/domain/PullRequestReview/Diff"
import * as Base64 from "effect/encoding/Base64"
import * as Option from "effect/Option"
import type { GitHubRequest, GitHubResponse } from "../../src/GitHub/Transport.ts"
import { FakeGitHub } from "../Labeling/fakeGitHub.ts"

/** The login GraphQL reports for janitor's App, which is also the viewer. */
export const APP_LOGIN = "effect-janitor"

export interface FakeThreadComment {
  readonly id: string
  readonly author: string
  /** Written by janitor's App, the viewer of every GraphQL call. */
  readonly byApp: boolean
  readonly body: string
  readonly createdAt: string
  /** The review the comment belongs to. */
  readonly reviewId?: string
}

export interface FakeThread {
  readonly id: string
  readonly path: string
  readonly line: number | null
  readonly startLine: number | null
  readonly side: string
  isResolved: boolean
  isOutdated: boolean
  resolvedBy: string | null
  comments: Array<FakeThreadComment>
}

export interface FakeReview {
  readonly id: string
  readonly databaseId: number
  readonly author: string
  readonly byApp: boolean
  state: "PENDING" | "COMMENTED" | "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED"
  body: string
  readonly commitOID: string
}

type FakeFile = string | { readonly size: number }

export interface FakeCheckRun {
  readonly id: number
  readonly headSha: string
  status: string
  conclusion: string | null
  output: { readonly title: string; readonly summary: string }
}

/** The id `/app` answers for janitor's App. */
export const APP_ID = 4242

const MUTATIONS = [
  "addPullRequestReviewThreadReply",
  "addPullRequestReviewThread",
  "addPullRequestReview",
  "submitPullRequestReview",
  "deletePullRequestReview",
  "dismissPullRequestReview",
] as const

const SUBMITTED = {
  APPROVE: "APPROVED",
  REQUEST_CHANGES: "CHANGES_REQUESTED",
  COMMENT: "COMMENTED",
} as const

/**
 * The GitHub a PR review run talks to, for pull request `number`: contents at
 * any ref, and the review threads and reviews behind GraphQL. Mutations change
 * that state the way GitHub does: one pending review per viewer, threads and
 * replies join it through `pullRequestReviewId`, and lines outside the diff are
 * refused. GraphQL calls send one operation each, with mutation arguments in
 * `variables.input`.
 */
export class FakeReviewGitHub extends FakeGitHub {
  readonly files = new Map<string, Map<string, FakeFile>>()
  threads: Array<FakeThread> = []
  reviews: Array<FakeReview> = []
  /** Janitor's `janitor/review` check runs, as created and updated. */
  checkRuns: Array<FakeCheckRun> = []
  /** Refuse dismissals, as for an App missing from the dismissal allow-list. */
  dismissalForbidden = false
  /** Answer a recursive tree listing the way GitHub does for a large repository: top level only, `truncated`. */
  treeTruncated = false
  private ids = 0

  constructor(readonly number = 7) {
    super()
  }

  /** A file at `ref`; a `{ size }` file is over the contents API's 1 MB cap. */
  file(ref: string, path: string, content: FakeFile) {
    const tree = this.files.get(ref) ?? new Map<string, FakeFile>()
    tree.set(path, content)
    this.files.set(ref, tree)
    return this
  }

  get mutationTimes() {
    return this.requests.flatMap((request, index) =>
      request.method !== "GET" &&
      (request.url !== "/graphql" || /^\s*mutation\b/.test(this.graphql(request).query))
        ? [this.requestTimes[index]!]
        : [],
    )
  }

  /**
   * What a write request does: the GraphQL mutation's field, or the REST
   * operation as `GitHub.ts` names it. Reads have no name.
   */
  writeName(request: GitHubRequest): string | undefined {
    if (request.method === "GET") return undefined
    if (request.url === "/graphql") {
      const { query } = this.graphql(request)
      return /^\s*mutation\b/.test(query)
        ? MUTATIONS.find((field) => new RegExp(`\\b${field}\\s*\\(`).test(query))
        : undefined
    }
    if (request.url.endsWith("/check-runs")) return "createCheckRun"
    if (/\/check-runs\/\d+$/.test(request.url)) return "updateCheckRun"
    if (request.url.endsWith("/dismissals")) return "dismissReview"
    return `${request.method} ${request.url}`
  }

  /** Every write so far, in order, by `writeName`. */
  get writeNames() {
    return this.requests.flatMap((request) => this.writeName(request) ?? [])
  }

  /** A GraphQL mutation's `variables.input`; other requests have none. */
  mutationInput(request: GitHubRequest): Record<string, any> | undefined {
    return request.url === "/graphql" ? this.graphql(request).variables?.input : undefined
  }

  /** GitHub's answer refusing a GraphQL mutation, as for a 422 (`UNPROCESSABLE`) or a 403 (`FORBIDDEN`). */
  refusal(request: GitHubRequest, type: string, message: string): GitHubResponse {
    return this.error(this.writeName(request) ?? "unknown", type, message)
  }

  private nextId(prefix: string) {
    return `${prefix}_${++this.ids}`
  }

  private graphql(request: GitHubRequest) {
    return request.body as { query: string; variables?: { input?: Record<string, unknown> } }
  }

  private data(data: unknown): GitHubResponse {
    return this.ok({ data })
  }

  private error(field: string, type: string, message: string): GitHubResponse {
    return this.ok({ data: { [field]: null }, errors: [{ type, path: [field], message }] })
  }

  private contents(ref: string | null, path: string): GitHubResponse {
    const tree = ref === null ? undefined : this.files.get(ref)
    const found = tree?.get(path)
    if (typeof found === "string") {
      const bytes = new TextEncoder().encode(found)
      return this.ok({
        type: "file",
        name: path.split("/").at(-1),
        path,
        size: bytes.byteLength,
        encoding: "base64",
        content: Base64.encode(bytes).replace(/(.{60})/g, "$1\n"),
      })
    }
    // Between 1 MB and 100 MB the contents API answers without the content.
    if (found !== undefined)
      return this.ok({
        type: "file",
        name: path.split("/").at(-1),
        path,
        size: found.size,
        encoding: "none",
        content: "",
      })
    const prefix = path === "" ? "" : `${path}/`
    const entries = new Map<string, "file" | "dir">()
    for (const candidate of tree?.keys() ?? []) {
      if (!candidate.startsWith(prefix)) continue
      const [name, ...rest] = candidate.slice(prefix.length).split("/")
      entries.set(name!, rest.length === 0 ? "file" : "dir")
    }
    if (entries.size === 0) return this.failed(404)
    return this.ok([...entries].map(([name, type]) => ({ type, name, path: `${prefix}${name}` })))
  }

  /** The git trees API at `ref`: every file and directory under it, or the top level only. */
  private gitTree(ref: string, recursive: boolean): GitHubResponse {
    const paths = new Map<string, "blob" | "tree">()
    for (const path of this.files.get(ref)?.keys() ?? []) {
      const parts = path.split("/")
      parts.forEach((_, index) =>
        paths.set(
          parts.slice(0, index + 1).join("/"),
          index === parts.length - 1 ? "blob" : "tree",
        ),
      )
    }
    const truncated = recursive && this.treeTruncated
    const tree = [...paths]
      .filter(([path]) => (recursive && !truncated) || !path.includes("/"))
      .map(([path, type]) => ({
        path,
        mode: type === "blob" ? "100644" : "040000",
        type,
        sha: ref,
      }))
    return this.ok({ sha: ref, tree, truncated })
  }

  private pending() {
    return this.reviews.find((review) => review.byApp && review.state === "PENDING")
  }

  private resolvable(path: string, line: number, startLine: number) {
    const files = this.pull(this.number)?.files ?? []
    const file = parseTrustedDiff(
      files.map((file) => ({
        filename: file.filename,
        status: file.status as "modified",
        ...(file.patch === undefined ? {} : { patch: file.patch }),
      })),
    ).files.find((file) => file.path === path)
    return (
      file?._tag === "Anchorable" &&
      file.hunks.some((hunk) => hunk.startLine <= startLine && line <= hunk.endLine)
    )
  }

  private query(): GitHubResponse {
    const page = { hasNextPage: false, endCursor: null }
    return this.data({
      repository: {
        pullRequest: {
          id: `PR_${this.number}`,
          number: this.number,
          reviewThreads: {
            totalCount: this.threads.length,
            pageInfo: page,
            nodes: this.threads.map((thread) => ({
              id: thread.id,
              path: thread.path,
              line: thread.line,
              startLine: thread.startLine,
              diffSide: thread.side,
              isResolved: thread.isResolved,
              isOutdated: thread.isOutdated,
              resolvedBy: thread.resolvedBy === null ? null : { login: thread.resolvedBy },
              comments: {
                totalCount: thread.comments.length,
                pageInfo: page,
                nodes: thread.comments.map((comment) => ({
                  id: comment.id,
                  body: comment.body,
                  createdAt: comment.createdAt,
                  author: { __typename: comment.byApp ? "Bot" : "User", login: comment.author },
                  viewerDidAuthor: comment.byApp,
                  pullRequestReview:
                    comment.reviewId === undefined
                      ? null
                      : {
                          id: comment.reviewId,
                          state:
                            this.reviews.find((review) => review.id === comment.reviewId)?.state ??
                            "COMMENTED",
                        },
                })),
              },
            })),
          },
          reviews: {
            totalCount: this.reviews.length,
            pageInfo: page,
            nodes: this.reviews.map((review) => ({
              id: review.id,
              databaseId: review.databaseId,
              state: review.state,
              body: review.body,
              commit: { oid: review.commitOID },
              author: { __typename: review.byApp ? "Bot" : "User", login: review.author },
              viewerDidAuthor: review.byApp,
            })),
          },
        },
      },
    })
  }

  private mutation(request: GitHubRequest): GitHubResponse {
    const { query, variables } = this.graphql(request)
    const fields = MUTATIONS.filter((field) => new RegExp(`\\b${field}\\s*\\(`).test(query))
    if (fields.length !== 1) return this.ok({ errors: [{ message: "One mutation per request" }] })
    const field = fields[0]!
    const input = variables?.input as Record<string, any> | undefined
    if (input === undefined) return this.error(field, "INVALID", "Arguments go in variables.input")
    const pending = this.pending()
    const joinsPending = pending !== undefined && input.pullRequestReviewId === pending.id
    switch (field) {
      case "addPullRequestReview": {
        if (input.pullRequestId !== `PR_${this.number}`)
          return this.error(field, "NOT_FOUND", "Could not resolve the pull request")
        if (pending !== undefined)
          return this.error(field, "UNPROCESSABLE", "One pending review per pull request")
        const review: FakeReview = {
          id: this.nextId("PRR"),
          databaseId: 900 + this.ids,
          author: APP_LOGIN,
          byApp: true,
          state:
            input.event === undefined
              ? "PENDING"
              : SUBMITTED[input.event as keyof typeof SUBMITTED],
          body: input.body ?? "",
          commitOID: input.commitOID ?? this.pull(this.number)?.headSha ?? "a".repeat(40),
        }
        this.reviews.push(review)
        return this.data({
          [field]: {
            pullRequestReview: {
              id: review.id,
              databaseId: review.databaseId,
              state: review.state,
            },
          },
        })
      }
      case "addPullRequestReviewThread": {
        if (!joinsPending) return this.error(field, "NOT_FOUND", "No such pending review")
        const line = input.line as number
        const startLine = (input.startLine as number | undefined) ?? line
        if (!this.resolvable(input.path, line, startLine))
          return this.error(field, "UNPROCESSABLE", "Line must be part of the diff")
        const thread: FakeThread = {
          id: this.nextId("PRRT"),
          path: input.path,
          line,
          startLine: input.startLine ?? null,
          side: input.side ?? "RIGHT",
          isResolved: false,
          isOutdated: false,
          resolvedBy: null,
          comments: [
            {
              id: this.nextId("PRRC"),
              author: APP_LOGIN,
              byApp: true,
              body: input.body,
              createdAt: "2026-10-14T12:00:00Z",
              reviewId: pending.id,
            },
          ],
        }
        this.threads.push(thread)
        return this.data({ [field]: { thread: { id: thread.id } } })
      }
      case "addPullRequestReviewThreadReply": {
        const thread = this.threads.find((thread) => thread.id === input.pullRequestReviewThreadId)
        if (!joinsPending || thread === undefined)
          return this.error(field, "NOT_FOUND", "No such pending review or thread")
        const comment: FakeThreadComment = {
          id: this.nextId("PRRC"),
          author: APP_LOGIN,
          byApp: true,
          body: input.body,
          createdAt: "2026-10-14T12:00:00Z",
          reviewId: pending.id,
        }
        thread.comments.push(comment)
        return this.data({ [field]: { comment: { id: comment.id } } })
      }
      case "submitPullRequestReview": {
        if (!joinsPending) return this.error(field, "NOT_FOUND", "No such pending review")
        pending.state = SUBMITTED[input.event as keyof typeof SUBMITTED]
        pending.body = input.body ?? ""
        return this.data({
          [field]: { pullRequestReview: { id: pending.id, state: pending.state } },
        })
      }
      case "deletePullRequestReview": {
        if (!joinsPending) return this.error(field, "NOT_FOUND", "No such pending review")
        this.reviews = this.reviews.filter((review) => review !== pending)
        for (const thread of this.threads)
          thread.comments = thread.comments.filter((comment) => comment.reviewId !== pending.id)
        this.threads = this.threads.filter((thread) => thread.comments.length > 0)
        return this.data({ [field]: { pullRequestReview: { id: pending.id } } })
      }
      case "dismissPullRequestReview": {
        const review = this.reviews.find((review) => review.id === input.pullRequestReviewId)
        if (review === undefined) return this.error(field, "NOT_FOUND", "No such review")
        if (this.dismissalForbidden)
          return this.error(field, "FORBIDDEN", "Resource not accessible by integration")
        review.state = "DISMISSED"
        return this.data({ [field]: { pullRequestReview: { id: review.id } } })
      }
    }
  }

  override respond(request: GitHubRequest): GitHubResponse {
    if (request.method === "POST" && request.url === "/graphql")
      return /^\s*mutation\b/.test(this.graphql(request).query)
        ? this.mutation(request)
        : this.query()
    const url = new URL(request.url, "https://api.github.com")
    const rest = url.pathname.startsWith(this.path) ? url.pathname.slice(this.path.length) : null
    if (url.pathname === "/app" && request.method === "GET") return this.ok({ id: APP_ID })
    // Janitor's check runs on a commit, newest first, as `filter=latest` lists them.
    const listed = rest === null ? null : /^\/commits\/([0-9a-f]+)\/check-runs$/.exec(rest)
    if (listed && request.method === "GET")
      return this.ok({
        check_runs: this.checkRuns
          .filter((checkRun) => checkRun.headSha === listed[1])
          .reverse()
          .map((checkRun) => ({
            id: checkRun.id,
            html_url: `https://github.com/checks/${checkRun.id}`,
          })),
      })
    // The REST pull request adds what the base fake leaves out: the author's
    // account type and the base repository's visibility.
    if (rest === `/pulls/${this.number}` && request.method === "GET") {
      const response = super.respond(request)
      if (response._tag !== "Ok") return response
      const body = response.body as {
        user: { login: string } | null
        base: Record<string, unknown>
      }
      return this.ok({
        ...body,
        user:
          body.user === null
            ? null
            : { ...body.user, type: body.user.login.endsWith("[bot]") ? "Bot" : "User" },
        base: { ...body.base, repo: { private: false, visibility: "public" } },
      })
    }
    if (rest === "/check-runs" && request.method === "POST") {
      const body = request.body as {
        head_sha: string
        status: string
        conclusion?: string
        output: { title: string; summary: string }
      }
      const checkRun: FakeCheckRun = {
        id: 9000 + this.checkRuns.length,
        headSha: body.head_sha,
        status: body.status,
        conclusion: body.conclusion ?? null,
        output: body.output,
      }
      this.checkRuns.push(checkRun)
      return this.ok({ id: checkRun.id, html_url: `https://github.com/checks/${checkRun.id}` })
    }
    const checkRun = rest === null ? null : /^\/check-runs\/(\d+)$/.exec(rest)
    if (checkRun && request.method === "PATCH") {
      const found = this.checkRuns.find((run) => run.id === Number(checkRun[1]))
      if (found === undefined) return this.failed(404)
      const body = request.body as {
        status: string
        conclusion?: string
        output: { title: string; summary: string }
      }
      found.status = body.status
      found.conclusion = body.conclusion ?? null
      found.output = body.output
      return this.ok({ id: found.id, html_url: `https://github.com/checks/${found.id}` })
    }
    const contents = rest === null ? null : /^\/contents\/?(.*)$/.exec(rest)
    if (contents && request.method === "GET")
      return this.contents(url.searchParams.get("ref"), decodeURIComponent(contents[1]!))
    const tree = rest === null ? null : /^\/git\/trees\/([^/]+)$/.exec(rest)
    if (tree && request.method === "GET")
      return this.gitTree(decodeURIComponent(tree[1]!), url.searchParams.has("recursive"))
    // GitHub lists at most 3,000 changed files, and the last page has no next link.
    if (rest === `/pulls/${this.number}/files` && request.method === "GET")
      return this.page(
        url.pathname,
        url.searchParams,
        (this.pull(this.number)?.files ?? []).slice(0, 3000),
      )
    const dismissal =
      rest === null
        ? null
        : new RegExp(`^/pulls/${this.number}/reviews/(\\d+)/dismissals$`).exec(rest)
    if (dismissal && request.method === "PUT") {
      const review = this.reviews.find((review) => review.databaseId === Number(dismissal[1]))
      if (review === undefined) return this.failed(404)
      if (this.dismissalForbidden)
        return {
          _tag: "Failed",
          status: 403,
          body: { message: "Forbidden" },
          requestId: Option.none(),
        }
      review.state = "DISMISSED"
      return this.ok({ id: review.databaseId, state: review.state })
    }
    if (rest === `/pulls/${this.number}/reviews` && request.method === "GET")
      return this.page(
        url.pathname,
        url.searchParams,
        this.reviews.map((review) => ({
          id: review.databaseId,
          node_id: review.id,
          user: review.byApp
            ? { login: `${APP_LOGIN}[bot]`, type: "Bot" }
            : { login: review.author, type: "User" },
          state: review.state,
          body: review.body,
          commit_id: review.commitOID,
        })),
      )
    return super.respond(request)
  }
}
