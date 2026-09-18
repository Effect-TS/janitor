import { assert, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type { DraftPublication } from "@janitor/domain/Review/Draft"
import type { Eligibility } from "../../src/RepositoryEligibility.ts"
import { GitHubTransport } from "../../src/GitHub/Transport.ts"
import { ReviewPullRequests } from "../../src/Review/PullRequests.ts"
import { FakeDraftGitHub } from "./fakeDraftGitHub.ts"

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
const draft: DraftPublication = {
  status: "branch",
  branch: "janitor/reproduction/30/run",
  baseCommit: "c".repeat(40),
  defaultBranch: "main",
  text: { title: "Failing test", body: "Agent text", publishedSummary: "", blockedSummary: "" },
  attempted: null,
  treeSha: "d".repeat(40),
  commitSha: "e".repeat(40),
  prNumber: null,
  url: null,
  reason: null,
}
const withGitHub = (fake: FakeDraftGitHub) =>
  ReviewPullRequests.layer.pipe(
    Layer.provide(
      Layer.succeed(GitHubTransport, {
        request: (r) =>
          fake.request(r).pipe(
            Effect.map((response) => {
              if (response === undefined) throw new Error(`Unexpected request ${r.url}`)
              return response
            }),
          ),
      }),
    ),
  )

it.effect(
  "creates only a draft in the selected repository with separate scoped permissions",
  () => {
    const fake = new FakeDraftGitHub()
    return Effect.gen(function* () {
      const github = yield* ReviewPullRequests
      yield* github.createBranch(repository, draft.branch, draft.commitSha!)
      const pr = yield* github.create(repository, draft, "Agent text")
      assert.isTrue(pr.owned)
      assert.isTrue(pr.draft)
      assert.deepStrictEqual(
        fake.mutations.map((r) => [r.method, r.url, r.repositoryPermission, r.body]),
        [
          [
            "POST",
            "/repos/effect/one/git/refs",
            { repositoryId: "701", issues: "read", contents: "write" },
            { ref: "refs/heads/janitor/reproduction/30/run", sha: "e".repeat(40) },
          ],
          [
            "POST",
            "/repos/effect/one/pulls",
            { repositoryId: "701", issues: "read", pullRequests: "write" },
            {
              title: "Failing test",
              body: "Agent text",
              head: "janitor/reproduction/30/run",
              base: "main",
              draft: true,
              maintainer_can_modify: false,
            },
          ],
        ],
      )
    }).pipe(Effect.provide(withGitHub(fake)))
  },
)

it.effect("does not establish ownership from a matching branch name or a PR from a fork", () => {
  const fake = new FakeDraftGitHub()
  fake.pulls.push(
    {
      number: 1,
      title: "Same",
      body: "Same",
      state: "open",
      draft: true,
      user: { id: 1 },
      head: { ref: draft.branch, sha: draft.commitSha, repo: { id: 701 } },
      base: { ref: "main", repo: { id: 701 } },
    },
    {
      number: 2,
      title: "Same",
      body: "Same",
      state: "open",
      draft: true,
      user: { id: 42 },
      head: { ref: draft.branch, sha: draft.commitSha, repo: { id: 999 } },
      base: { ref: "main", repo: { id: 701 } },
    },
  )
  return Effect.gen(function* () {
    const github = yield* ReviewPullRequests
    const prs = yield* github.list(repository, draft.branch)
    assert.deepStrictEqual(
      prs.map((pr) => pr.owned),
      [false, false],
    )
  }).pipe(Effect.provide(withGitHub(fake)))
})

it.effect("revalidates saved test scope against GitHub before any mutation", () => {
  const fake = new FakeDraftGitHub()
  return Effect.gen(function* () {
    const github = yield* ReviewPullRequests
    for (const path of ["src/fix.js", "test/package.json", ".github/workflows/test.yml"]) {
      const result = yield* github
        .validate(repository, {
          id: "invalid",
          baseCommit: draft.baseCommit,
          diff: "untrusted",
          files: [{ path, content: "change", rationale: "Claimed test helper" }],
        })
        .pipe(Effect.result)
      assert.strictEqual(result._tag, "Failure")
    }
    assert.lengthOf(fake.mutations, 0)
  }).pipe(Effect.provide(withGitHub(fake)))
})
