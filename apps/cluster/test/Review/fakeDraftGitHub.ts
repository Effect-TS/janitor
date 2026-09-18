import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import {
  GitHubTransportError,
  type GitHubRequest,
  type GitHubResponse,
} from "../../src/GitHub/Transport.ts"

const ok = (body: unknown): GitHubResponse => ({
  _tag: "Ok",
  status: 200,
  body,
  etag: Option.none(),
  link: Option.none(),
  requestId: Option.none(),
})
const absent: GitHubResponse = { _tag: "Failed", status: 404, body: {}, requestId: Option.none() }
export class FakeDraftGitHub {
  readonly branches = new Map<string, string>()
  readonly pulls: Array<Record<string, unknown>> = []
  readonly mutations: Array<GitHubRequest> = []
  afterWrite: Effect.Effect<void> = Effect.void
  lost: "branch" | "pr" | "tree" | "commit" | null = null
  rejectPr = false
  reset() {
    this.branches.clear()
    this.pulls.length = 0
    this.mutations.length = 0
    this.afterWrite = Effect.void
    this.lost = null
    this.rejectPr = false
  }
  readonly request = (
    r: GitHubRequest,
  ): Effect.Effect<GitHubResponse | undefined, GitHubTransportError> => {
    const fake = this
    return Effect.gen(function* () {
      if (r.url === "/app") return ok({ id: 42, slug: "janitor" })
      if (r.url === "/users/janitor%5Bbot%5D") {
        if (r.scope._tag !== "Installation" || r.repositoryPermission?.repositoryId !== "701")
          return yield* new GitHubTransportError({
            message: "Bot lookup requires scoped installation credentials.",
          })
        return ok({ id: 42 })
      }
      const path = r.url.replace("/repos/effect/one/", "")
      if (r.method === "GET") {
        if (path.startsWith("git/trees/"))
          return ok({
            truncated: false,
            tree: [
              { path: "test/existing.test.js", mode: "100644", type: "blob", sha: "b".repeat(40) },
            ],
          })
        if (path.startsWith("git/commits/")) return ok({ tree: { sha: "a".repeat(40) } })
        if (path.startsWith("git/ref/heads/")) {
          const sha = fake.branches.get(decodeURIComponent(path.slice("git/ref/heads/".length)))
          return sha === undefined ? absent : ok({ object: { sha } })
        }
        if (path.startsWith("pulls?")) return ok(fake.pulls)
        return undefined
      }
      if (!["git/trees", "git/commits", "git/refs", "pulls"].includes(path)) return undefined
      fake.mutations.push(r)
      const body = r.body as Record<string, unknown>
      let operation: "tree" | "commit" | "branch" | "pr"
      let result: GitHubResponse
      if (path === "git/trees") {
        operation = "tree"
        result = ok({ sha: "d".repeat(40) })
      } else if (path === "git/commits") {
        operation = "commit"
        result = ok({ sha: "e".repeat(40) })
      } else if (path === "git/refs") {
        operation = "branch"
        fake.branches.set(String(body.ref).replace("refs/heads/", ""), String(body.sha))
        result = ok({ object: { sha: body.sha } })
      } else {
        operation = "pr"
        if (fake.rejectPr)
          return { _tag: "Failed", status: 503, body: {}, requestId: Option.none() }
        const pr = {
          number: 123,
          title: body.title,
          body: body.body,
          state: "open",
          draft: body.draft,
          user: { id: 42 },
          head: { ref: body.head, sha: fake.branches.get(String(body.head)), repo: { id: 701 } },
          base: { ref: body.base, repo: { id: 701 } },
        }
        fake.pulls.push(pr)
        result = ok(pr)
      }
      yield* fake.afterWrite
      if (fake.lost === operation)
        return yield* new GitHubTransportError({ message: "Lost response" })
      return result
    })
  }
}
