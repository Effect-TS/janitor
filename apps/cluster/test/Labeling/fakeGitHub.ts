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

export interface FakeIssue {
  readonly number: number
  title: string
  body?: string | null
  state: "open" | "closed"
  labels: Array<FakeLabel>
  user?: { id: number; login: string } | null
  pullRequest?: boolean
  updatedAt?: string
}

/**
 * The GitHub the direct path reads and writes: a mutable issue set and label
 * catalog behind the transport, so tests can change GitHub independently of
 * the read model and observe every write.
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

  constructor(readonly path = "/repos/effect/one") {}

  get writes() {
    return this.requests.filter((request) => request.method !== "GET")
  }

  put(issue: FakeIssue) {
    this.issues.set(issue.number, issue)
    return this
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

  private ok(body: unknown): GitHubResponse {
    return {
      _tag: "Ok",
      status: 200,
      body,
      etag: Option.none(),
      link: Option.none(),
      requestId: Option.none(),
    }
  }

  private failed(status: number): GitHubResponse {
    return { _tag: "Failed", status, body: {}, requestId: Option.none() }
  }

  respond(request: GitHubRequest): GitHubResponse {
    const url = request.url.startsWith("https://")
      ? new URL(request.url).pathname + new URL(request.url).search
      : request.url
    const [pathname] = url.split("?")
    const rest = pathname!.startsWith(this.path) ? pathname!.slice(this.path.length) : null
    if (rest === null) return this.failed(404)
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
