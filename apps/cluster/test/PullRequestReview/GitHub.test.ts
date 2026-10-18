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
import { GitHubRateLimited, type GitHubResponse } from "../../src/GitHub/Transport.ts"
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

  it.effect("reports a listing that stops at GitHub's 3,000-file cap as truncated", () =>
    Effect.gen(function* () {
      const fake = makeFake(
        Array.from({ length: 3001 }, (_, index) => ({
          filename: `src/f${index}.ts`,
          status: "modified",
          additions: 1,
          deletions: 0,
        })),
      )
      const github = yield* client(fake)

      const changed = yield* github.changedFiles({ baseSha: BASE, lockfiles: [] })

      assert.strictEqual(changed.files.length, 3000)
      assert.isTrue(changed.truncated)
    }),
  )

  it.effect(
    "applies nested .gitattributes at the base SHA, also when the tree listing is truncated",
    () =>
      Effect.gen(function* () {
        const changed = (filename: string, additions: number) => ({
          filename,
          status: "modified",
          additions,
          deletions: 0,
        })
        for (const treeTruncated of [false, true]) {
          const fake = makeFake([
            changed("generated/schema.ts", 100),
            // A nested override of the root rule.
            changed("generated/hand/edit.ts", 3),
            changed("packages/api/out.ts", 200),
            // Anchored to its own directory, the nested `/out.ts` doesn't reach here.
            changed("packages/api/sub/out.ts", 5),
            changed("packages/api/sub/client.gen.ts", 300),
            changed("src/index.ts", 7),
          ])
            .file(BASE, ".gitattributes", "generated/** linguist-generated\n")
            .file(BASE, "generated/hand/.gitattributes", "*.ts -linguist-generated\n")
            .file(
              BASE,
              "packages/api/.gitattributes",
              "/out.ts linguist-generated\n*.gen.ts linguist-generated\n",
            )
            .file(HEAD, "src/.gitattributes", "* linguist-generated\n")
          fake.treeTruncated = treeTruncated
          const github = yield* client(fake)

          const { size } = yield* github.changedFiles({ baseSha: BASE, lockfiles: [] })

          assert.deepStrictEqual(size, { files: 3, lines: 15 }, `tree truncated: ${treeTruncated}`)
        }
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

  it.effect("refuses a directory with more files than the read bound", () =>
    Effect.gen(function* () {
      const fake = makeFake()
      for (let index = 0; index < 501; index++) {
        fake.file(BASE, `.agents/skills/review/references/note-${index}.md`, `note ${index}`)
      }
      const github = yield* client(fake)

      const error = yield* github.readDirectory(BASE, ".agents/skills").pipe(Effect.flip)

      assert.instanceOf(error, ReviewGitHub.DirectoryTooLarge)
      assert.deepInclude(error, { path: ".agents/skills", limit: 500 })
      // The bound still holds: three directory listings and at most 500 file reads.
      assert.isAtMost(fake.reads.length, 503)
    }),
  )

  it.effect("keeps only the App's marked threads and its submitted reviews", () =>
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
      fake.reviews = [
        {
          id: "PRR_1",
          databaseId: 901,
          author: APP_LOGIN,
          byApp: true,
          state: "CHANGES_REQUESTED",
          body: "Two blocking findings.",
          commitOID: HEAD,
        },
        {
          id: "PRR_2",
          databaseId: 902,
          author: APP_LOGIN,
          byApp: true,
          state: "PENDING",
          body: "",
          commitOID: HEAD,
        },
        {
          id: "PRR_3",
          databaseId: 903,
          author: "mallory",
          byApp: false,
          state: "APPROVED",
          body: "",
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
          reviewedSha: Option.some(HEAD),
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

  it.effect("finds janitor's pending review and the threads and replies it holds", () =>
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
      const marked = inlineComment({ comment: "Missing null check.", fingerprint })
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
          // Submitted by an earlier run, so not part of the pending review.
          comments: [{ ...comment("PRRC_earlier", APP_LOGIN, marked, 0), reviewId: "PRR_earlier" }],
        },
      ]
      const github = yield* client(fake)
      const before = yield* github.pendingReview

      const written = yield* withElapsingClock(
        Effect.gen(function* () {
          const review = yield* github.createPendingReview(HEAD)
          const thread = yield* github.addThread(review.id, {
            path: "src/a.ts",
            line: 12,
            body: marked,
          })
          const reply = yield* github.addReply(review.id, {
            threadId: "PRRT_earlier",
            body: "Still applies.",
          })
          return { review, thread, reply }
        }),
        Duration.millis(100),
      )
      // A restarted run has none of this run's state, only GitHub's.
      const restarted = yield* client(fake)

      assert.isTrue(Option.isNone(before))
      assert.deepStrictEqual(
        yield* restarted.pendingReview,
        Option.some({
          id: written.review.id,
          databaseId: written.review.databaseId,
          threads: [{ threadId: written.thread.threadId, path: "src/a.ts", line: 12, fingerprint }],
          replies: [{ threadId: "PRRT_earlier", commentId: written.reply.commentId }],
        }),
      )
    }),
  )

  it.effect(
    "replaces a leftover pending review and builds one pinned review step by step, a second between mutations",
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
          Effect.gen(function* () {
            yield* github.deletePendingReview
            const review = yield* github.createPendingReview(HEAD)
            yield* github.addThread(review.id, {
              path: "src/a.ts",
              line: 12,
              startLine: 10,
              body: "Range finding.",
            })
            yield* github.addReply(review.id, { threadId: "PRRT_earlier", body: "Still applies." })
            yield* github.submitPendingReview(review.id, {
              event: "REQUEST_CHANGES",
              body: "One blocking finding.",
            })
            return { reviewId: review.id }
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
        .dismissReview({ id: "PRR_1", databaseId: 901 }, "No blocking findings remain.")
        .pipe(Effect.flip)
      const unresolvable = yield* withElapsingClock(
        github.createPendingReview(HEAD).pipe(
          Effect.flatMap((review) =>
            github.addThread(review.id, { path: "src/a.ts", line: 99, body: "Not in the diff." }),
          ),
          Effect.flip,
        ),
        Duration.millis(100),
      )

      assert.strictEqual(dismissal._tag, "NotOnDismissalAllowList")
      assert.deepInclude(unresolvable, { _tag: "UnresolvableLine", path: "src/a.ts", line: 99 })
    }),
  )

  it.effect("keeps GitHub's response text out of its errors, which carry only a category", () =>
    Effect.gen(function* () {
      // GitHub's messages can quote what the request carried, such as review or PR text.
      const canary = "canary-response-text-that-must-not-be-logged"
      const fake = makeFake()
      const github = yield* client(fake)

      fake.intercept = () =>
        Effect.succeed({
          _tag: "Failed",
          status: 500,
          body: { message: canary },
          requestId: Option.none(),
        })
      const rest = yield* github.pullRequest.pipe(Effect.flip)
      fake.intercept = (request) =>
        Effect.succeed(
          fake.writeName(request) === undefined
            ? undefined
            : fake.refusal(request, "UNPROCESSABLE", canary),
        )
      const graphql = yield* withElapsingClock(
        github.createPendingReview(HEAD).pipe(Effect.flip),
        Duration.millis(100),
      )

      assert.deepInclude(rest, { _tag: "PullRequestGitHubError", status: 500 })
      assert.strictEqual(graphql._tag, "PullRequestGitHubUnprocessable")
      for (const error of [rest, graphql]) {
        assert.isString(error.operation)
        assert.notInclude(String(error), canary)
        assert.notInclude(JSON.stringify(error), canary)
      }
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

  it.effect("follows review threads, thread comments and reviews past their first page", () =>
    Effect.gen(function* () {
      const fake = makeFake()
      fake.graphqlPageSize = 2
      const marked = inlineComment({ comment: "Missing null check.", fingerprint })
      const thread = (id: string, comments: Array<FakeThreadComment>) => ({
        id,
        path: "src/a.ts",
        line: 1,
        startLine: null,
        side: "RIGHT",
        isResolved: false,
        isOutdated: false,
        resolvedBy: null,
        comments,
      })
      fake.threads = [
        thread("PRRT_1", [
          comment("PRRC_1", APP_LOGIN, marked, 1),
          comment("PRRC_2", "maintainer", "Why?", 2),
          comment("PRRC_3", APP_LOGIN, "See the docs.", 3),
        ]),
        thread("PRRT_2", [comment("PRRC_4", APP_LOGIN, marked, 4)]),
        thread("PRRT_3", [comment("PRRC_5", APP_LOGIN, marked, 5)]),
      ]
      fake.reviews = [901, 902, 903].map((databaseId) => ({
        id: `PRR_${databaseId}`,
        databaseId,
        author: APP_LOGIN,
        byApp: true,
        state: "COMMENTED" as const,
        body: "",
        commitOID: HEAD,
      }))
      const github = yield* client(fake)

      const history = yield* github.janitorHistory

      assert.deepStrictEqual(
        history.threads.map((thread) => [thread.id, thread.comments.map((comment) => comment.id)]),
        [
          ["PRRT_1", ["PRRC_1", "PRRC_2", "PRRC_3"]],
          ["PRRT_2", ["PRRC_4"]],
          ["PRRT_3", ["PRRC_5"]],
        ],
      )
      assert.deepStrictEqual(
        history.reviews.map((review) => review.id),
        ["PRR_901", "PRR_902", "PRR_903"],
      )
    }),
  )

  it.effect(
    "waits a minute out on a GraphQL rate limit, through the transport's graphql budget",
    () =>
      Effect.gen(function* () {
        const fake = makeFake()
        fake.reviews = [
          {
            id: "PRR_1",
            databaseId: 901,
            author: APP_LOGIN,
            byApp: true,
            state: "COMMENTED",
            body: "",
            commitOID: HEAD,
          },
        ]
        let limited = false
        fake.intercept = () =>
          Effect.sync(() => {
            if (limited) return undefined
            limited = true
            return {
              _tag: "Ok",
              status: 200,
              body: { errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] },
              etag: Option.none(),
              link: Option.none(),
              requestId: Option.none(),
            }
          })
        const github = yield* client(fake)

        const fiber = yield* Effect.forkChild(github.findReview("PRR_1"))
        yield* Effect.yieldNow
        yield* TestClock.adjust(Duration.seconds(59))
        assert.strictEqual(fake.requests.length, 1)
        yield* TestClock.adjust(Duration.seconds(1))

        assert.isTrue(Option.isSome(yield* Fiber.join(fiber)))
        assert.deepStrictEqual(
          fake.requests.map(({ scope, priority, method, url, resource }) => ({
            scope,
            priority,
            method,
            url,
            resource,
          })),
          Array.from({ length: 2 }, () => ({
            scope: { _tag: "Installation" as const, installationId: target.installationId },
            priority: "foreground" as const,
            method: "POST" as const,
            url: "/graphql",
            resource: "graphql",
          })),
        )
      }),
  )

  it.effect("maps GraphQL answers without the requested data to typed errors", () =>
    Effect.gen(function* () {
      const fake = makeFake([
        { filename: "src/a.ts", status: "modified", patch: "@@ -1 +1,2 @@\n+one\n+two" },
      ])
      const github = yield* client(fake)
      const answer = (body: unknown): GitHubResponse => ({
        _tag: "Ok",
        status: 200,
        body,
        etag: Option.none(),
        link: Option.none(),
        requestId: Option.none(),
      })
      const refused = (type: string) =>
        answer({ data: null, errors: [{ type, message: "Refused." }] })
      const findWith = (response: GitHubResponse) =>
        Effect.gen(function* () {
          fake.intercept = () => Effect.succeed(response)
          return yield* github.findReview("PRR_1").pipe(Effect.flip)
        })

      const forbidden = yield* findWith(refused("FORBIDDEN"))
      const notFound = yield* findWith(refused("NOT_FOUND"))
      const noPullRequest = yield* findWith(answer({ data: { repository: null } }))
      const timedOut = yield* findWith({
        _tag: "Failed",
        status: 502,
        body: {},
        requestId: Option.none(),
      })
      // GitHub can also refuse a line outside the diff by creating no thread, without an error.
      fake.intercept = (request) =>
        Effect.succeed(
          fake.writeName(request) === "addPullRequestReviewThread"
            ? answer({ data: { addPullRequestReviewThread: { thread: null } } })
            : undefined,
        )
      const noThread = yield* withElapsingClock(
        github.createPendingReview(HEAD).pipe(
          Effect.flatMap((review) =>
            github.addThread(review.id, { path: "src/a.ts", line: 1, body: "Finding." }),
          ),
          Effect.flip,
        ),
        Duration.millis(100),
      )

      assert.strictEqual(forbidden._tag, "PullRequestGitHubForbidden")
      assert.strictEqual(notFound._tag, "PullRequestGitHubNotFound")
      assert.strictEqual(noPullRequest._tag, "PullRequestGitHubNotFound")
      assert.deepInclude(timedOut, { _tag: "PullRequestGitHubError", status: 502 })
      assert.deepInclude(noThread, { _tag: "UnresolvableLine", path: "src/a.ts", line: 1 })
    }),
  )
})
