import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { GitHubInstallationId } from "@janitor/domain/GitHub/Id"
import { briefWaits } from "../../src/Labeling/GitHubIssue.ts"
import { readPullRequest } from "../../src/Labeling/GitHubPullRequest.ts"
import { FakeGitHub } from "./fakeGitHub.ts"

const repository = { installationId: GitHubInstallationId.make("77"), owner: "effect", repo: "one" }

const reasonOf = (files: { readonly complete: boolean; readonly reason?: string } | undefined) =>
  files?.complete === false ? files.reason : undefined

const read = (github: FakeGitHub, tracks: Array<"changed_files" | "checks" | "reviews">) =>
  readPullRequest("Test", repository, 5, tracks, briefWaits).pipe(Effect.provide(github.layer))

describe("Direct pull request reads", () => {
  it.effect("follows every page of each required collection and folds review history", () =>
    Effect.gen(function* () {
      const github = new FakeGitHub().put({
        number: 5,
        title: "Change 5",
        state: "open",
        labels: [],
        pullRequest: {
          baseRef: "develop",
          draft: true,
          files: Array.from({ length: 250 }, (_, index) => ({
            filename: `src/file-${index}.ts`,
            status: "modified",
          })),
          checks: [
            { name: "build", status: "completed", conclusion: "success" },
            { name: "lint", status: "in_progress", conclusion: null },
          ],
          reviews: [
            { id: 1, user: "alice", state: "CHANGES_REQUESTED" },
            { id: 2, user: "bob", state: "COMMENTED" },
            { id: 3, user: "alice", state: "APPROVED" },
            { id: 4, user: "carol", state: "APPROVED" },
            { id: 5, user: "carol", state: "DISMISSED" },
            { id: 6, user: null, state: "APPROVED" },
          ],
        },
      })
      const result = yield* read(github, ["changed_files", "checks", "reviews"])
      assert.strictEqual(result._tag, "Found")
      if (result._tag !== "Found") return
      assert.deepStrictEqual(
        [result.pullRequest.base.ref, result.pullRequest.draft, result.pullRequest.merged],
        ["develop", true, false],
      )
      assert.strictEqual(result.collections.changedFiles?.complete, true)
      assert.strictEqual(result.collections.changedFiles?.files.length, 250)
      assert.deepStrictEqual(result.collections.checks, [
        { name: "build", state: "success" },
        { name: "lint", state: "in_progress" },
      ])
      assert.deepStrictEqual(result.collections.reviews, [{ reviewer: "alice", state: "APPROVED" }])
      // Three file pages, one check page, one review page, and the pull twice.
      assert.deepStrictEqual(
        github.reads.map((request) => request.url.replace(/^https:\/\/api\.github\.com/, "")),
        [
          "/repos/effect/one/pulls/5",
          "/repos/effect/one/pulls/5/files?per_page=100",
          "/repos/effect/one/pulls/5/files?per_page=100&page=2",
          "/repos/effect/one/pulls/5/files?per_page=100&page=3",
          `/repos/effect/one/commits/${"a".repeat(40)}/check-runs?per_page=100`,
          "/repos/effect/one/pulls/5/reviews?per_page=100",
          "/repos/effect/one/pulls/5",
        ],
      )
    }),
  )

  it.effect("reads only the required collections and none for an empty requirement", () =>
    Effect.gen(function* () {
      const github = new FakeGitHub().put({
        number: 5,
        title: "Change 5",
        state: "open",
        labels: [],
        pullRequest: { files: [{ filename: "a.ts", status: "added" }] },
      })
      const none = yield* read(github, [])
      assert.strictEqual(none._tag, "Found")
      if (none._tag === "Found") assert.deepStrictEqual(none.collections, {})
      assert.strictEqual(github.reads.length, 1)
      const files = yield* read(github, ["changed_files"])
      assert.strictEqual(files._tag, "Found")
      if (files._tag === "Found")
        assert.deepStrictEqual(files.collections, {
          changedFiles: { files: [{ path: "a.ts", status: "added" }], complete: true },
        })
    }),
  )

  it.effect("reports a changed-file listing that GitHub bounds or cannot reconcile", () =>
    Effect.gen(function* () {
      const github = new FakeGitHub().put({
        number: 5,
        title: "Change 5",
        state: "open",
        labels: [],
        pullRequest: {
          changedFiles: 3001,
          files: Array.from({ length: 3001 }, (_, index) => ({
            filename: `f${index}`,
            status: "added",
          })),
        },
      })
      const bounded = yield* read(github, ["changed_files"])
      assert.strictEqual(bounded._tag, "Found")
      if (bounded._tag === "Found") {
        assert.strictEqual(bounded.collections.changedFiles?.complete, false)
        assert.strictEqual(bounded.collections.changedFiles?.files.length, 3000)
        assert.include(reasonOf(bounded.collections.changedFiles), "3000 of 3001")
      }
      github.pull(5)!.changedFiles = 4
      github.pull(5)!.files = [{ filename: "one", status: "added" }]
      const mismatch = yield* read(github, ["changed_files"])
      assert.strictEqual(mismatch._tag, "Found")
      if (mismatch._tag === "Found") {
        assert.strictEqual(mismatch.collections.changedFiles?.complete, false)
        assert.include(reasonOf(mismatch.collections.changedFiles), "did not match")
      }
    }),
  )

  it.effect("rereads once when the pull request changes underneath the collections", () =>
    Effect.gen(function* () {
      const github = new FakeGitHub().put({
        number: 5,
        title: "Change 5",
        state: "open",
        labels: [],
        pullRequest: { headSha: "1".repeat(40), files: [{ filename: "a", status: "added" }] },
      })
      let pushes = 0
      github.intercept = (request) =>
        Effect.sync(() => {
          // A push lands after the first read of the pull request.
          if (request.url.endsWith("/files?per_page=100") && pushes++ === 0)
            github.pull(5)!.headSha = "2".repeat(40)
          return undefined
        })
      const result = yield* read(github, ["changed_files"])
      assert.strictEqual(result._tag, "Found")
      if (result._tag === "Found") assert.strictEqual(result.pullRequest.head.sha, "2".repeat(40))
      assert.strictEqual(
        github.reads.filter((request) => request.url.endsWith("/pulls/5")).length,
        4,
      )

      // Every listing races another push: the observation never settles.
      let flips = 0
      github.intercept = (request) =>
        Effect.sync(() => {
          if (request.url.endsWith("/files?per_page=100"))
            github.pull(5)!.headSha = String(3 + (flips++ % 2)).repeat(40)
          return undefined
        })
      const unstable = yield* read(github, ["changed_files"])
      assert.strictEqual(unstable._tag, "Changed")
    }),
  )

  it.effect("answers unavailable for a pull request GitHub does not serve", () =>
    Effect.gen(function* () {
      const github = new FakeGitHub().put({ number: 5, title: "Issue", state: "open", labels: [] })
      const result = yield* read(github, ["checks"])
      assert.deepStrictEqual(result, {
        _tag: "Unavailable",
        status: 404,
        message: "GitHub responded 404",
      })
    }),
  )
})
