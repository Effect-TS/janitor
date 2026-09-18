import { assert, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import {
  GitHubTransport,
  type GitHubRequest,
  type GitHubResponse,
} from "../../src/GitHub/Transport.ts"
import { ReviewComments } from "../../src/Review/Comments.ts"
import type { Eligibility } from "../../src/RepositoryEligibility.ts"

const repository: Eligibility = {
  repositoryId: "701",
  installationId: "77",
  name: "effect/one",
  generation: "1",
  connected: true,
  paused: false,
  accessAvailable: true,
  blockReason: null,
}
const ok = (body: unknown): GitHubResponse => ({
  _tag: "Ok",
  status: 200,
  body,
  etag: Option.none(),
  link: Option.none(),
  requestId: Option.none(),
})
const comment = (id: number, app: number | null) => ({
  id,
  body: `Comment ${id}`,
  performed_via_github_app: app === null ? null : { id: app },
})

it.effect("reconciles every page using only comments authored by this App", () => {
  const requests: Array<GitHubRequest> = []
  const layer = ReviewComments.layer.pipe(
    Layer.provide(
      Layer.succeed(GitHubTransport, {
        request: (request) =>
          Effect.sync(() => {
            requests.push(request)
            if (request.url === "/app") return ok({ id: 42 })
            if (request.url.endsWith("page=1"))
              return ok(Array.from({ length: 100 }, (_, i) => comment(i, i === 0 ? 42 : null)))
            return ok([comment(101, 42), comment(102, 43)])
          }),
      }),
    ),
  )
  return Effect.gen(function* () {
    const comments = yield* ReviewComments
    assert.deepStrictEqual(yield* comments.list(repository, 30), [
      { id: "0", body: "Comment 0" },
      { id: "101", body: "Comment 101" },
    ])
    assert.deepStrictEqual(
      requests.filter((r) => r.scope._tag === "Installation").map((r) => r.repositoryPermission),
      [
        { repositoryId: "701", issues: "read" },
        { repositoryId: "701", issues: "read" },
      ],
    )
  }).pipe(Effect.provide(layer))
})

it.effect(
  "permits only issue comment creation and update with repository-scoped issues permission",
  () => {
    const requests: Array<GitHubRequest> = []
    const layer = ReviewComments.layer.pipe(
      Layer.provide(
        Layer.succeed(GitHubTransport, {
          request: (request) =>
            Effect.sync(() => {
              requests.push(request)
              return ok({ ...comment(100, 42), body: "Agent prose" })
            }),
        }),
      ),
    )
    return Effect.gen(function* () {
      const comments = yield* ReviewComments
      yield* comments.write(repository, 30, null, "Agent prose")
      yield* comments.write(repository, 30, "100", "Agent prose")
      assert.deepStrictEqual(
        requests.map((r) => [r.method, r.url, r.repositoryPermission, r.body]),
        [
          [
            "POST",
            "/repos/effect/one/issues/30/comments",
            { repositoryId: "701", issues: "write" },
            { body: "Agent prose" },
          ],
          [
            "PATCH",
            "/repos/effect/one/issues/comments/100",
            { repositoryId: "701", issues: "write" },
            { body: "Agent prose" },
          ],
        ],
      )
    }).pipe(Effect.provide(layer))
  },
)

it.effect("rejects repository-defined autolinks outside evidence before publication", () => {
  let rendered = '<p><a href="https://janitor.example.test/ticket/123">TASK-123</a></p>'
  const layer = ReviewComments.layer.pipe(
    Layer.provide(
      Layer.succeed(GitHubTransport, {
        request: (request) =>
          Effect.sync(() => {
            assert.strictEqual(request.url, "/markdown")
            assert.deepStrictEqual(request.repositoryPermission, {
              repositoryId: "701",
              issues: "read",
              contents: "read",
            })
            assert.deepStrictEqual(request.body, {
              text: "Agent text",
              mode: "gfm",
              context: "effect/one",
            })
            return ok(rendered)
          }),
      }),
    ),
  )
  return Effect.gen(function* () {
    const comments = yield* ReviewComments
    const permitted = ["https://github.com/effect/one/issues/31"]
    assert.isFalse(yield* comments.checkLinks(repository, "Agent text", permitted))
    rendered = '<p><a href="https://github.com/effect/one/issues/31">#31</a></p>'
    assert.isTrue(yield* comments.checkLinks(repository, "Agent text", permitted))
  }).pipe(Effect.provide(layer))
})
