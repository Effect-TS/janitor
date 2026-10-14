import { assert, describe, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as TestClock from "effect/testing/TestClock"
import { GitHubInstallationId } from "@janitor/domain/GitHub/Id"
import { Fingerprint } from "@janitor/domain/PullRequestReview/Fingerprint"
import { inlineComment } from "@janitor/domain/PullRequestReview/Render"
import { RunId } from "@janitor/domain/PullRequestReview/Run"
import { GitHubRateLimited } from "../../src/GitHub/Transport.ts"
import * as ReviewGitHub from "../../src/PullRequestReview/GitHub.ts"
import type { FakePullRequest } from "../Labeling/fakeGitHub.ts"
import { withElapsingClock } from "../support/TestTime.ts"
import { APP_LOGIN, FakeReviewGitHub, type FakeThreadComment } from "./fakeGitHub.ts"

const BASE = "b".repeat(40)
const HEAD = "a".repeat(40)
const target = {
  installationId: GitHubInstallationId.make("77"),
  owner: "effect",
  repo: "one",
  number: 7,
}

const makeFake = (files: NonNullable<FakePullRequest["files"]> = []) =>
  new FakeReviewGitHub(7).put({
    number: 7,
    title: "Change",
    state: "open",
    labels: [],
    pullRequest: { headSha: HEAD, files },
  })

const client = (fake: FakeReviewGitHub) =>
  ReviewGitHub.make(target).pipe(Effect.provide(fake.layer))

const comment = (
  id: string,
  author: string,
  body: string,
  minute: number,
  byApp = author === APP_LOGIN,
): FakeThreadComment => ({
  id,
  author,
  byApp,
  body,
  createdAt: `2026-10-14T12:${String(minute).padStart(2, "0")}:00Z`,
})

const fingerprint = Fingerprint.make("f".repeat(64))
const runId = RunId.make("3f9b6c1e-2d4a-4e8b-9c7d-1a2b3c4d5e6f")

describe("PR review GitHub", () => {
  it.effect(
    "pages through changed files and counts size without lockfiles, generated files or changesets",
    () =>
      Effect.gen(function* () {
        const fake = makeFake([
          ...Array.from({ length: 120 }, (_, index) => ({
            filename: `src/f${index}.ts`,
            status: "modified",
            additions: 2,
            deletions: 1,
          })),
          { filename: "pnpm-lock.yaml", status: "modified", additions: 400, deletions: 300 },
          { filename: "apps/web/yarn.lock", status: "modified", additions: 50, deletions: 0 },
          { filename: "generated/schema.ts", status: "modified", additions: 900, deletions: 0 },
          { filename: "api/service.pb.go", status: "added", additions: 700, deletions: 0 },
          { filename: ".changeset/brave-cats.md", status: "added", additions: 5, deletions: 0 },
        ])
          .file(
            BASE,
            ".gitattributes",
            "generated/** linguist-generated=true\n*.pb.go linguist-generated\n",
          )
          // Only the base SHA's attributes count; the head can't mark its own changes generated.
          .file(HEAD, ".gitattributes", "src/** linguist-generated\n")
        const github = yield* client(fake)

        const changed = yield* github.changedFiles({
          baseSha: BASE,
          lockfiles: ["pnpm-lock.yaml", "yarn.lock"],
        })

        assert.strictEqual(changed.files.length, 125)
        assert.isFalse(changed.truncated)
        assert.deepStrictEqual(changed.size, { files: 120, lines: 360 })
      }),
  )

  it.effect(
    "reads files and directories at a ref, with missing and oversized files unreadable",
    () =>
      Effect.gen(function* () {
        const fake = makeFake()
          .file(BASE, "AGENTS.md", "# Agents — über\n")
          .file(BASE, ".agents/skills/review/SKILL.md", "review skill")
          .file(BASE, ".agents/skills/review/references/checks.md", "checks")
          .file(HEAD, ".agents/skills/new/SKILL.md", "added at head")
          .file(HEAD, "src/a.ts", "export const a = 1\n")
          .file(HEAD, "src/big.json", { size: 1_500_000 })
        const github = yield* client(fake)

        const agents = yield* github.readFile(BASE, "AGENTS.md")
        const review = yield* github.readFile(BASE, ".github/janitor/review.md")
        const skills = yield* github.readDirectory(BASE, ".agents/skills")
        const head = yield* github.readFile(HEAD, "src/a.ts")
        const gone = yield* github.readFile(HEAD, "src/gone.ts")
        const big = yield* github.readFile(HEAD, "src/big.json")

        assert.deepStrictEqual(agents, { _tag: "Read", text: "# Agents — über\n" })
        assert.deepStrictEqual(review, { _tag: "Unreadable" })
        assert.deepStrictEqual(
          [...skills].sort((a, b) => (a.path < b.path ? -1 : 1)),
          [
            {
              path: ".agents/skills/review/SKILL.md",
              blob: { _tag: "Read", text: "review skill" },
            },
            {
              path: ".agents/skills/review/references/checks.md",
              blob: { _tag: "Read", text: "checks" },
            },
          ],
        )
        assert.deepStrictEqual(head, { _tag: "Read", text: "export const a = 1\n" })
        assert.deepStrictEqual(gone, { _tag: "Unreadable" })
        assert.deepStrictEqual(big, { _tag: "Unreadable" })
      }),
  )

  it.effect("keeps only the App's threads and reviews that carry valid markers", () =>
    Effect.gen(function* () {
      const fake = makeFake()
      const marked = inlineComment({ comment: "Missing null check.", fingerprint })
      fake.threads = [
        {
          id: "PRRT_1",
          path: "src/a.ts",
          line: 12,
          startLine: 10,
          side: "RIGHT",
          isResolved: true,
          isOutdated: false,
          resolvedBy: "maintainer",
          comments: [
            comment("PRRC_1", APP_LOGIN, marked, 1),
            comment("PRRC_2", "maintainer", "Fixed upstream.", 2),
            comment("PRRC_3", APP_LOGIN, "Addressed in abc.", 3),
          ],
        },
        {
          id: "PRRT_2",
          path: "src/b.ts",
          line: 3,
          startLine: null,
          side: "RIGHT",
          isResolved: false,
          isOutdated: true,
          resolvedBy: null,
          comments: [comment("PRRC_4", APP_LOGIN, "No marker here.", 4)],
        },
        {
          id: "PRRT_3",
          path: "src/c.ts",
          line: 5,
          startLine: null,
          side: "RIGHT",
          isResolved: false,
          isOutdated: false,
          resolvedBy: null,
          // A user may share the App's login and copy its marker.
          comments: [comment("PRRC_5", APP_LOGIN, marked, 5, false)],
        },
      ]
      const reviewMarker = `<!-- janitor:review run=${runId} sha=${HEAD} -->`
      fake.reviews = [
        {
          id: "PRR_1",
          databaseId: 901,
          author: APP_LOGIN,
          byApp: true,
          state: "CHANGES_REQUESTED",
          body: `Two blocking findings.\n\n${reviewMarker}`,
          commitOID: HEAD,
        },
        {
          id: "PRR_2",
          databaseId: 902,
          author: APP_LOGIN,
          byApp: true,
          state: "COMMENTED",
          body: "No marker.",
          commitOID: HEAD,
        },
        {
          id: "PRR_3",
          databaseId: 903,
          author: "mallory",
          byApp: false,
          state: "APPROVED",
          body: reviewMarker,
          commitOID: HEAD,
        },
      ]
      const github = yield* client(fake)

      const history = yield* github.janitorHistory

      assert.deepStrictEqual(
        history.threads.map((thread) => ({
          ...thread,
          comments: thread.comments.map((comment) => ({
            id: comment.id,
            by: comment.byJanitor ? "janitor" : comment.author,
            body: comment.body,
            at: DateTime.formatIso(comment.createdAt),
          })),
        })),
        [
          {
            id: "PRRT_1",
            path: "src/a.ts",
            line: 12,
            startLine: 10,
            isResolved: true,
            isOutdated: false,
            resolvedBy: Option.some("maintainer"),
            fingerprint,
            comments: [
              { id: "PRRC_1", by: "janitor", body: marked, at: "2026-10-14T12:01:00.000Z" },
              {
                id: "PRRC_2",
                by: "maintainer",
                body: "Fixed upstream.",
                at: "2026-10-14T12:02:00.000Z",
              },
              {
                id: "PRRC_3",
                by: "janitor",
                body: "Addressed in abc.",
                at: "2026-10-14T12:03:00.000Z",
              },
            ],
          },
        ],
      )
      assert.deepStrictEqual(history.reviews, [
        {
          id: "PRR_1",
          databaseId: 901,
          state: "CHANGES_REQUESTED",
          marker: { runId, reviewedSha: HEAD },
        },
      ])
    }),
  )

  it.effect("looks up each login's permission once per run", () =>
    Effect.gen(function* () {
      const fake = makeFake()
      fake.permissions.set("alice", { id: 1, permission: "write" })
      fake.permissions.set("bob", { id: 2, permission: "read" })
      const github = yield* client(fake)

      const permissions = [
        yield* github.permission("alice"),
        yield* github.permission("alice"),
        yield* github.permission("bob"),
      ]

      assert.deepStrictEqual(permissions, ["write", "write", "read"])
      assert.strictEqual(
        fake.reads.filter((request) => request.url.includes("/collaborators/")).length,
        2,
      )
    }),
  )

  it.effect(
    "replaces a leftover pending review and submits one pinned review, a second between mutations",
    () =>
      Effect.gen(function* () {
        const fake = makeFake([
          {
            filename: "src/a.ts",
            status: "modified",
            patch:
              "@@ -1,3 +1,20 @@\n" +
              Array.from({ length: 20 }, (_, i) => `+line ${i + 1}`).join("\n"),
          },
        ])
        // The head moved on after the run pinned HEAD.
        fake.pull(7)!.headSha = "d".repeat(40)
        fake.reviews = [
          {
            id: "PRR_leftover",
            databaseId: 900,
            author: APP_LOGIN,
            byApp: true,
            state: "PENDING",
            body: "",
            commitOID: HEAD,
          },
        ]
        fake.threads = [
          {
            id: "PRRT_earlier",
            path: "src/a.ts",
            line: 2,
            startLine: null,
            side: "RIGHT",
            isResolved: false,
            isOutdated: false,
            resolvedBy: null,
            comments: [comment("PRRC_earlier", APP_LOGIN, "Earlier finding.", 0)],
          },
          {
            id: "PRRT_leftover",
            path: "src/a.ts",
            line: 4,
            startLine: null,
            side: "RIGHT",
            isResolved: false,
            isOutdated: false,
            resolvedBy: null,
            comments: [
              {
                ...comment("PRRC_leftover", APP_LOGIN, "Half-posted.", 0),
                reviewId: "PRR_leftover",
              },
            ],
          },
        ]
        const github = yield* client(fake)

        const submitted = yield* withElapsingClock(
          github.submitReview({
            commitId: HEAD,
            event: "REQUEST_CHANGES",
            body: "One blocking finding.",
            threads: [{ path: "src/a.ts", line: 12, startLine: 10, body: "Range finding." }],
            replies: [{ threadId: "PRRT_earlier", body: "Still applies." }],
          }),
          Duration.millis(100),
        )

        assert.deepStrictEqual(
          fake.reviews.map(({ id, state, body, commitOID }) => ({ id, state, body, commitOID })),
          [
            {
              id: submitted.reviewId,
              state: "CHANGES_REQUESTED",
              body: "One blocking finding.",
              commitOID: HEAD,
            },
          ],
        )
        assert.deepStrictEqual(
          fake.threads.map((thread) => ({
            id: thread.id,
            path: thread.path,
            line: thread.line,
            startLine: thread.startLine,
            side: thread.side,
            comments: thread.comments.map((comment) => [comment.body, comment.reviewId]),
          })),
          [
            {
              id: "PRRT_earlier",
              path: "src/a.ts",
              line: 2,
              startLine: null,
              side: "RIGHT",
              comments: [
                ["Earlier finding.", undefined],
                ["Still applies.", submitted.reviewId],
              ],
            },
            {
              id: fake.threads[1]!.id,
              path: "src/a.ts",
              line: 12,
              startLine: 10,
              side: "RIGHT",
              comments: [["Range finding.", submitted.reviewId]],
            },
          ],
        )
        const times = fake.mutationTimes
        assert.strictEqual(times.length, 5)
        times.slice(1).forEach((time, index) => assert.isAtLeast(time - times[index]!, 1000))
      }),
  )

  it.effect("maps a forbidden dismissal and a line outside the diff to typed errors", () =>
    Effect.gen(function* () {
      const fake = makeFake([
        { filename: "src/a.ts", status: "modified", patch: "@@ -1 +1,2 @@\n+one\n+two" },
      ])
      fake.dismissalForbidden = true
      fake.reviews = [
        {
          id: "PRR_1",
          databaseId: 901,
          author: APP_LOGIN,
          byApp: true,
          state: "CHANGES_REQUESTED",
          body: "",
          commitOID: HEAD,
        },
      ]
      const github = yield* client(fake)

      const dismissal = yield* github
        .dismissReview(
          {
            id: "PRR_1",
            databaseId: 901,
            state: "CHANGES_REQUESTED",
            marker: { runId, reviewedSha: HEAD },
          },
          "No blocking findings remain.",
        )
        .pipe(Effect.flip)
      const unresolvable = yield* withElapsingClock(
        github
          .submitReview({
            commitId: HEAD,
            event: "COMMENT",
            body: "A nit.",
            threads: [{ path: "src/a.ts", line: 99, body: "Not in the diff." }],
            replies: [],
          })
          .pipe(Effect.flip),
        Duration.millis(100),
      )

      assert.strictEqual(dismissal._tag, "NotOnDismissalAllowList")
      assert.deepInclude(unresolvable, { _tag: "UnresolvableLine", path: "src/a.ts", line: 99 })
    }),
  )

  it.effect("retries a rate-limited request once the stated time has passed", () =>
    Effect.gen(function* () {
      const fake = makeFake()
      fake.permissions.set("alice", { id: 1, permission: "write" })
      let limited = false
      fake.intercept = () =>
        Effect.gen(function* () {
          if (limited) return undefined
          limited = true
          const now = yield* DateTime.now
          return yield* new GitHubRateLimited({
            scopeKey: "installation:77",
            until: DateTime.addDuration(now, Duration.seconds(30)),
            reason: "retry-after",
          })
        })
      const github = yield* client(fake)

      const fiber = yield* Effect.forkChild(github.permission("alice"))
      yield* Effect.yieldNow
      yield* TestClock.adjust(Duration.seconds(29))
      assert.strictEqual(fake.requests.length, 1)
      yield* TestClock.adjust(Duration.seconds(1))

      assert.strictEqual(yield* Fiber.join(fiber), "write")
      assert.strictEqual(fake.requests.length, 2)
    }),
  )
})
