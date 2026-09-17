import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import {
  type GitHubRequest,
  type GitHubResponse,
  GitHubTransport,
  type GitHubTransportFailure,
} from "../../src/GitHub/Transport.ts"

export interface FakeLabel {
  readonly id: number
  readonly name: string
}

/** The pull request side of an item: what `/pulls/{n}` and its collections answer. */
export interface FakePullRequest {
  draft?: boolean
  merged?: boolean
  baseRef?: string
  headSha?: string
  /** The `changed_files` count GitHub reports; defaults to the listed files. */
  changedFiles?: number
  files?: Array<{ filename: string; status: string }>
  checks?: Array<{ name: string; status: string; conclusion: string | null }>
  reviews?: Array<{ id: number; user: string | null; state: string }>
}

export interface FakeIssue {
  readonly number: number
  title: string
  body?: string | null
  state: "open" | "closed"
  labels: Array<FakeLabel>
  user?: { id: number; login: string } | null
  /** `true` for a pull request with default details, or the details themselves. */
  pullRequest?: boolean | FakePullRequest
  updatedAt?: string
}

const DEFAULT_HEAD = "a".repeat(40)

/**
 * The GitHub the direct path reads and writes: a mutable item set and label
 * catalog behind the transport, so tests can change GitHub independently of
 * the read model and observe every request. Collections page like GitHub,
 * honouring `per_page` and answering a `Link: rel="next"` header.
 */
export class FakeGitHub {
  readonly issues = new Map<number, FakeIssue>()
  labels: Array<FakeLabel> = []
  readonly requests: Array<GitHubRequest> = []
  /** Runs before every request; fail it to simulate throttling or outages. */
  intercept: (
    request: GitHubRequest,
  ) => Effect.Effect<GitHubResponse | undefined, GitHubTransportFailure> = () =>
    Effect.succeed(undefined)

  constructor(
    readonly path = "/repos/effect/one",
    readonly repositoryId = 701,
    readonly installationId = 77,
  ) {}

  get writes() {
    return this.requests.filter((request) => request.method !== "GET")
  }

  get reads() {
    return this.requests.filter((request) => request.method === "GET")
  }

  put(issue: FakeIssue) {
    this.issues.set(issue.number, issue)
    return this
  }

  /** The pull request details of an item, or `undefined` for an issue. */
  pull(number: number): FakePullRequest | undefined {
    const issue = this.issues.get(number)
    if (issue === undefined || !issue.pullRequest) return undefined
    if (issue.pullRequest === true) issue.pullRequest = {}
    return issue.pullRequest
  }

  private body(issue: FakeIssue) {
    return {
      id: 1000 + issue.number,
      node_id: `I_${issue.number}`,
      number: issue.number,
      title: issue.title,
      body: issue.body ?? null,
      state: issue.state,
      user: issue.user === undefined ? { id: 9, login: "octocat" } : issue.user,
      labels: issue.labels.map((label) => ({
        id: label.id,
        node_id: `LA_${label.id}`,
        name: label.name,
      })),
      updated_at: issue.updatedAt ?? "2026-09-17T10:00:00Z",
      ...(issue.pullRequest ? { pull_request: { url: "https://api.github.com/x" } } : {}),
    }
  }

  private pullBody(issue: FakeIssue, pull: FakePullRequest) {
    return {
      ...this.body(issue),
      id: 2000 + issue.number,
      node_id: `PR_${issue.number}`,
      draft: pull.draft ?? false,
      merged: pull.merged ?? false,
      merged_at: pull.merged ? "2026-09-17T11:00:00Z" : null,
      changed_files: pull.changedFiles ?? pull.files?.length ?? 0,
      head: { sha: pull.headSha ?? DEFAULT_HEAD },
      base: { ref: pull.baseRef ?? "main", sha: "b".repeat(40) },
    }
  }

  private ok(body: unknown, link: Option.Option<string> = Option.none()): GitHubResponse {
    return {
      _tag: "Ok",
      status: 200,
      body,
      etag: Option.none(),
      link,
      requestId: Option.none(),
    }
  }

  private failed(status: number): GitHubResponse {
    return { _tag: "Failed", status, body: {}, requestId: Option.none() }
  }

  /** One page of a listing, with GitHub's `Link` header when more follows. */
  private page<A>(
    pathname: string,
    search: URLSearchParams,
    items: ReadonlyArray<A>,
    wrap: (items: ReadonlyArray<A>) => unknown = (items) => items,
  ): GitHubResponse {
    const perPage = Number(search.get("per_page") ?? "30")
    const page = Number(search.get("page") ?? "1")
    const slice = items.slice((page - 1) * perPage, page * perPage)
    const link =
      page * perPage < items.length
        ? Option.some(
            `<https://api.github.com${pathname}?per_page=${perPage}&page=${page + 1}>; rel="next"`,
          )
        : Option.none<string>()
    return this.ok(wrap(slice), link)
  }

  respond(request: GitHubRequest): GitHubResponse {
    const url = request.url.startsWith("https://")
      ? new URL(request.url).pathname + new URL(request.url).search
      : request.url
    const [pathname, query] = url.split("?")
    const search = new URLSearchParams(query ?? "")
    // Connection changes verify the installation and the repository first.
    if (request.method === "GET" && pathname === `/app/installations/${this.installationId}`)
      return this.ok({
        id: this.installationId,
        account: { id: 1, login: "effect", type: "Organization" },
        repository_selection: "all",
        html_url: `https://github.com/settings/installations/${this.installationId}`,
        suspended_at: null,
        permissions: { metadata: "read", issues: "write", pull_requests: "read", checks: "read" },
      })
    const rest = pathname!.startsWith(this.path) ? pathname!.slice(this.path.length) : null
    if (rest === null) return this.failed(404)
    if (request.method === "GET" && rest === "") return this.ok({ id: this.repositoryId })
    if (request.method === "GET" && rest === "/labels")
      return this.ok(
        this.labels.map((label) => ({ id: label.id, node_id: `LA_${label.id}`, name: label.name })),
      )
    if (request.method === "GET" && rest === "/issues") {
      const open = [...this.issues.values()]
        .filter((issue) => issue.state === "open")
        .sort((a, b) => b.number - a.number)
      return this.ok(open.map((issue) => this.body(issue)))
    }
    const single = /^\/issues\/(\d+)$/.exec(rest)
    if (single && request.method === "GET") {
      const issue = this.issues.get(Number(single[1]))
      return issue === undefined ? this.failed(404) : this.ok(this.body(issue))
    }
    const pull = /^\/pulls\/(\d+)$/.exec(rest)
    if (pull && request.method === "GET") {
      const issue = this.issues.get(Number(pull[1]))
      const details = this.pull(Number(pull[1]))
      return issue === undefined || details === undefined
        ? this.failed(404)
        : this.ok(this.pullBody(issue, details))
    }
    const files = /^\/pulls\/(\d+)\/files$/.exec(rest)
    if (files && request.method === "GET") {
      const details = this.pull(Number(files[1]))
      return details === undefined
        ? this.failed(404)
        : this.page(pathname!, search, details.files ?? [])
    }
    const reviews = /^\/pulls\/(\d+)\/reviews$/.exec(rest)
    if (reviews && request.method === "GET") {
      const details = this.pull(Number(reviews[1]))
      return details === undefined
        ? this.failed(404)
        : this.page(
            pathname!,
            search,
            (details.reviews ?? []).map((review) => ({
              id: review.id,
              user: review.user === null ? null : { id: 1, login: review.user },
              state: review.state,
            })),
          )
    }
    const checks = /^\/commits\/([0-9a-f]+)\/check-runs$/.exec(rest)
    if (checks && request.method === "GET") {
      const details = [...this.issues.keys()]
        .map((number) => this.pull(number))
        .find((pull) => pull !== undefined && (pull.headSha ?? DEFAULT_HEAD) === checks[1])
      return details === undefined
        ? this.failed(404)
        : this.page(pathname!, search, details.checks ?? [], (items) => ({ check_runs: items }))
    }
    const add = /^\/issues\/(\d+)\/labels$/.exec(rest)
    if (add && request.method === "POST") {
      const issue = this.issues.get(Number(add[1]))
      if (issue === undefined) return this.failed(404)
      const names = (request.body as { labels: Array<string> }).labels
      for (const name of names) {
        const label = this.labels.find((label) => label.name === name)
        if (label === undefined) return this.failed(404)
        if (!issue.labels.some((present) => present.id === label.id)) issue.labels.push(label)
      }
      return this.ok(issue.labels)
    }
    const remove = /^\/issues\/(\d+)\/labels\/([^/]+)$/.exec(rest)
    if (remove && request.method === "DELETE") {
      const issue = this.issues.get(Number(remove[1]))
      if (issue === undefined) return this.failed(404)
      const name = decodeURIComponent(remove[2]!)
      const before = issue.labels.length
      issue.labels = issue.labels.filter((label) => label.name !== name)
      return issue.labels.length === before ? this.failed(404) : this.ok(issue.labels)
    }
    return this.failed(404)
  }

  get layer() {
    const self = this
    return Layer.succeed(GitHubTransport, {
      request: (request) =>
        Effect.gen(function* () {
          self.requests.push(request)
          const intercepted = yield* self.intercept(request)
          return intercepted ?? self.respond(request)
        }),
    })
  }
}
