import { assert, layer } from "@effect/vitest"
import * as TestRunner from "effect/cluster/TestRunner"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/sql/SqlClient"
import * as WorkflowEngine from "effect/workflow/WorkflowEngine"
import {
  GitHubCommentDatabaseId,
  GitHubCommitSha,
  GitHubUserDatabaseId,
} from "@janitor/domain/GitHub/Id"
import { GitHubWebhookEvent } from "@janitor/domain/GitHub/WebhookEvent"
import { GitHubWebhookJournalSequence } from "@janitor/domain/GitHub/WebhookJournal"
import { ContentPurge } from "../../src/ContentPurge.ts"
import { applyEvent } from "../../src/GitHub/ProjectWebhook.ts"
import { GitHubReadModel } from "../../src/GitHub/ReadModel.ts"
import {
  type AdmissionEvent,
  AdmissionPayload,
  AdmitPullRequestReview,
  AdmitPullRequestReviewLayer,
  PR_REVIEW_ADMISSION_TAG,
  PullRequestReviewAutomationIntegrationLayer,
} from "../../src/PullRequestReview/Admission.ts"
import { PullRequestScheduler } from "../../src/PullRequestReview/Scheduler.ts"
import { PullRequestReviewStore } from "../../src/PullRequestReview/Store.ts"
import { RepositoryEligibility } from "../../src/RepositoryEligibility.ts"
import { SyncTargets } from "../../src/SyncTargets.ts"
import { WorkflowOutbox } from "../../src/WorkflowOutbox.ts"
import { MigratedPostgresLayer } from "../support/Postgres.ts"
import { FakeReviewGitHub } from "./fakeGitHub.ts"
import { repositoryId, seedRepositories, settle } from "./support.ts"

const HEAD = GitHubCommitSha.make("a".repeat(40))
const NEXT = GitHubCommitSha.make("d".repeat(40))
const comment = (id: string) => GitHubCommentDatabaseId.make(id)
const user = (id: string) => GitHubUserDatabaseId.make(id)
/** Pull request and comment text that must never reach a payload. */
const CANARY = "canary-text-that-must-not-leak"

/** The deployment's environment; the gate is on while the API key is set. */
const env: Record<string, string> = {}
const gateOn = () => (env["PR_REVIEW_OPENROUTER_API_KEY"] = "test-key")
const gateOff = () => delete env["PR_REVIEW_OPENROUTER_API_KEY"]

const github = new FakeReviewGitHub(7)

/** What the per-PR scheduler was told, in order. */
const told: Array<{ readonly _tag: string } & Record<string, unknown>> = []
const record =
  (_tag: string) =>
  ({ payload }: { readonly payload: object }) =>
    Effect.sync(() => {
      told.push({ _tag, ...payload })
    })

const RecordingScheduler = PullRequestScheduler.toLayer(
  PullRequestScheduler.of({
    HeadChanged: record("HeadChanged"),
    Reopened: record("Reopened"),
    Closed: record("Closed"),
    ConvertedToDraft: record("ConvertedToDraft"),
    Rerun: record("Rerun"),
    RunFinished: record("RunFinished"),
    RunOverdue: record("RunOverdue"),
    RepoDisabled: record("RepoDisabled"),
    CooldownElapsed: record("CooldownElapsed"),
    Wipe: record("Wipe"),
  }),
)

const Services = Layer.mergeAll(
  AdmitPullRequestReviewLayer,
  PullRequestReviewAutomationIntegrationLayer,
  RecordingScheduler,
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      PullRequestReviewStore.layer,
      RepositoryEligibility.layer,
      GitHubReadModel.layer,
      SyncTargets.layer,
      ContentPurge.layer,
    ),
  ),
  Layer.provideMerge(WorkflowOutbox.layer),
  Layer.provideMerge(github.layer),
  Layer.provideMerge(TestRunner.layer),
  Layer.provideMerge(WorkflowEngine.layerMemory),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
  Layer.provideMerge(MigratedPostgresLayer),
)

const human = { id: 9, login: "octocat", type: "User" }
const bot = (login: string) => ({ id: 49699333, login, type: "Bot" })

const pullRequestEvent = (
  action: string,
  options: {
    readonly draft?: boolean
    readonly state?: "open" | "closed"
    readonly merged?: boolean
    readonly user?: { id: number; login: string; type: string }
    readonly title?: string
    readonly private?: boolean
  } = {},
) => ({
  action,
  number: 7,
  ...(action === "synchronize" ? { before: HEAD, after: NEXT } : {}),
  pull_request: {
    id: 2007,
    number: 7,
    node_id: "PR_7",
    title: options.title ?? `Fix the cache ${CANARY}`,
    body: `Body ${CANARY}`,
    state: options.state ?? "open",
    draft: options.draft ?? false,
    merged: options.merged ?? false,
    updated_at: "2026-10-15T12:00:00Z",
    labels: [],
    user: options.user ?? human,
    head: { sha: action === "synchronize" ? NEXT : HEAD },
    base: { ref: "main" },
  },
  repository: { id: 701, full_name: "effect/one", private: options.private ?? false },
  installation: { id: 77 },
  sender: options.user ?? human,
})

const commentEvent = (
  body: string,
  options: {
    readonly action?: "created" | "edited"
    readonly user?: { id: number; login: string; type: string }
    readonly state?: "open" | "closed"
    readonly draft?: boolean
    readonly onPullRequest?: boolean
  } = {},
) => ({
  action: options.action ?? "created",
  ...(options.action === "edited" ? { changes: { body: { from: "/janitor" } } } : {}),
  issue: {
    id: 1007,
    number: 7,
    title: `Fix the cache ${CANARY}`,
    state: options.state ?? "open",
    draft: options.draft ?? false,
    user: human,
    ...((options.onPullRequest ?? true)
      ? { pull_request: { url: "https://api.github.com/repos/effect/one/pulls/7" } }
      : {}),
  },
  comment: {
    id: 501,
    body,
    user: options.user ?? { id: 31, login: "maintainer", type: "User" },
    performed_via_github_app: null,
  },
  repository: { id: 701, full_name: "effect/one", private: false },
  installation: { id: 77 },
  sender: options.user ?? { id: 31, login: "maintainer", type: "User" },
})

let sequence = 500
const nextSequence = () => GitHubWebhookJournalSequence.make(String(++sequence))

/** Projects one webhook delivery and returns its journal sequence. */
const deliver = (name: "pull_request" | "issue_comment", payload: unknown) =>
  Effect.gen(function* () {
    const event = yield* Schema.decodeUnknownEffect(GitHubWebhookEvent)({
      id: crypto.randomUUID(),
      name,
      payload,
    })
    const journal = nextSequence()
    yield* applyEvent(event, journal)
    return journal
  })

/** The admission rows enqueued since the last call, removed so the next case starts clean. */
const takeQueued = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{ payload: unknown }>`
    DELETE FROM workflow_outbox WHERE workflow_tag = ${PR_REVIEW_ADMISSION_TAG} RETURNING payload`
  return rows.map((row) => row.payload)
})

/** Runs the admission workflow for one event to completion. */
const admit = (event: AdmissionEvent) => settle(AdmitPullRequestReview.execute(admission(event)))

const admission = (event: AdmissionEvent) =>
  Schema.decodeSync(AdmissionPayload)({
    repositoryId,
    number: 7,
    sequence: nextSequence(),
    event,
  })

const reset = Effect.gen(function* () {
  yield* seedRepositories(repositoryId)
  gateOn()
  told.length = 0
  github.requests.length = 0
  github.checkRuns = []
  github.permissions.clear()
  github.put({
    number: 7,
    title: `Fix the cache ${CANARY}`,
    state: "open",
    labels: [],
    pullRequest: {
      headSha: HEAD,
      files: [{ filename: "src/cache.ts", status: "modified", additions: 10, deletions: 2 }],
    },
  })
  yield* takeQueued
})

const changed = (count: number, lines: number, prefix = "src/f") =>
  Array.from({ length: count }, (_, index) => ({
    filename: `${prefix}${index}.ts`,
    status: "modified",
    additions: lines,
    deletions: 0,
  }))

layer(Services, { timeout: "2 minutes" })("PR review admission", (it) => {
  it.effect(
    "enqueues one ids-only row per admitted event inside the projection, without GitHub I/O",
    () =>
      Effect.gen(function* () {
        yield* reset
        const cases: ReadonlyArray<readonly [string, unknown, AdmissionEvent]> = [
          ["pull_request", pullRequestEvent("opened"), { _tag: "HeadChanged", headSha: HEAD }],
          [
            "pull_request",
            pullRequestEvent("ready_for_review"),
            { _tag: "HeadChanged", headSha: HEAD },
          ],
          ["pull_request", pullRequestEvent("synchronize"), { _tag: "HeadChanged", headSha: NEXT }],
          ["pull_request", pullRequestEvent("reopened"), { _tag: "Reopened", headSha: HEAD }],
          [
            "pull_request",
            pullRequestEvent("closed", { state: "closed", merged: true }),
            { _tag: "Closed" },
          ],
          [
            "pull_request",
            pullRequestEvent("converted_to_draft", { draft: true }),
            { _tag: "ConvertedToDraft" },
          ],
          [
            "issue_comment",
            commentEvent(`/janitor focus on ${CANARY}`),
            {
              _tag: "Invoked",
              commentId: comment("501"),
              authorId: user("31"),
              authorLogin: "maintainer",
            },
          ],
        ]
        for (const [name, payload, event] of cases) {
          const journal = yield* deliver(name as "pull_request" | "issue_comment", payload)
          // Ids only: the exact payload, with no pull request or comment text.
          assert.deepStrictEqual(
            yield* takeQueued,
            [{ repositoryId: "701", number: 7, sequence: journal, event }],
            `${name} ${event._tag}`,
          )
        }
        assert.deepStrictEqual(github.requests, [])
        assert.deepStrictEqual(told, [])
      }),
  )

  it.effect("skips events that fail the cheap checks, and writes nothing for them", () =>
    Effect.gen(function* () {
      yield* reset
      const store = yield* PullRequestReviewStore
      const skipped = (name: "pull_request" | "issue_comment", payload: unknown, label: string) =>
        Effect.gen(function* () {
          yield* deliver(name, payload)
          assert.deepStrictEqual(yield* takeQueued, [], label)
        })

      gateOff()
      yield* skipped("pull_request", pullRequestEvent("opened"), "gate off")
      gateOn()
      yield* store.setEnabled(repositoryId, false)
      yield* skipped("pull_request", pullRequestEvent("opened"), "repository flag off")
      yield* skipped("issue_comment", commentEvent("/janitor"), "repository flag off, /janitor")
      yield* store.setEnabled(repositoryId, true)
      yield* skipped("pull_request", pullRequestEvent("opened", { private: true }), "private")

      for (const author of ["dependabot[bot]", "renovate[bot]", "github-actions[bot]"])
        yield* skipped(
          "pull_request",
          pullRequestEvent("opened", { user: bot(author), title: "Version Packages" }),
          author,
        )
      yield* skipped("pull_request", pullRequestEvent("opened", { draft: true }), "draft")
      yield* skipped("pull_request", pullRequestEvent("synchronize", { draft: true }), "draft push")

      yield* skipped("issue_comment", commentEvent("/janitor", { state: "closed" }), "closed")
      yield* skipped("issue_comment", commentEvent("/janitor", { draft: true }), "draft comment")
      yield* skipped(
        "issue_comment",
        commentEvent("/janitor", { user: bot("github-actions[bot]") }),
        "bot comment",
      )
      yield* skipped(
        "issue_comment",
        commentEvent("/janitor", { user: bot("effect-janitor[bot]") }),
        "the App's comment",
      )
      yield* skipped("issue_comment", commentEvent("/janitor", { action: "edited" }), "edited")
      yield* skipped(
        "issue_comment",
        commentEvent("/janitor", { onPullRequest: false }),
        "comment on an issue",
      )
      yield* skipped("issue_comment", commentEvent("> /janitor\n\nnot me"), "quoted command")

      assert.deepStrictEqual(github.requests, [])
      assert.deepStrictEqual(
        (yield* store.runs(repositoryId, { limit: 10, cursor: Option.none() })).runs,
        [],
      )
    }),
  )

  it.effect("checks the invoker's effective permission before telling the scheduler", () =>
    Effect.gen(function* () {
      yield* reset
      github.permissions.set("maintainer", { id: 31, permission: "write" })
      github.permissions.set("owner", { id: 32, permission: "admin" })
      github.permissions.set("reader", { id: 33, permission: "read" })
      const invoked = (authorLogin: string, authorId: string) =>
        admit({
          _tag: "Invoked",
          commentId: comment("501"),
          authorId: user(authorId),
          authorLogin,
        })

      yield* invoked("reader", "33")
      // The login now belongs to someone else than the comment's author.
      yield* invoked("maintainer", "99")
      // Not a collaborator at all: the lookup answers 404.
      yield* invoked("stranger", "34")
      assert.deepStrictEqual(told, [])

      yield* invoked("maintainer", "31")
      yield* invoked("owner", "32")
      assert.deepStrictEqual(told, [
        {
          _tag: "Rerun",
          repositoryId: "701",
          number: 7,
          headSha: HEAD,
          trigger: { _tag: "Rerun", invoker: "maintainer", commentId: "501" },
        },
        {
          _tag: "Rerun",
          repositoryId: "701",
          number: 7,
          headSha: HEAD,
          trigger: { _tag: "Rerun", invoker: "owner", commentId: "501" },
        },
      ])
    }),
  )

  it.effect("passes pull request events on to the scheduler with ids only", () =>
    Effect.gen(function* () {
      yield* reset
      yield* admit({ _tag: "HeadChanged", headSha: HEAD })
      yield* admit({ _tag: "Reopened", headSha: HEAD })
      yield* admit({ _tag: "Closed" })
      yield* admit({ _tag: "ConvertedToDraft" })
      const ids = { repositoryId: "701", number: 7 }
      assert.deepStrictEqual(told, [
        { _tag: "HeadChanged", ...ids, headSha: HEAD },
        { _tag: "Reopened", ...ids, headSha: HEAD },
        { _tag: "Closed", ...ids },
        { _tag: "ConvertedToDraft", ...ids },
      ])
    }),
  )

  it.effect(
    "skips an oversized pull request with a row and a neutral check run, unless /janitor forces it",
    () =>
      Effect.gen(function* () {
        yield* reset
        const store = yield* PullRequestReviewStore
        const pull = github.pull(7)!
        const outcome = (files: NonNullable<typeof pull.files>) =>
          Effect.gen(function* () {
            pull.files = files
            told.length = 0
            yield* admit({ _tag: "HeadChanged", headSha: HEAD })
            return told.length === 1 ? "runs" : "skipped"
          })

        // Lockfiles and changesets don't count toward the limits.
        const lockfile = {
          filename: "pnpm-lock.yaml",
          status: "modified",
          additions: 5000,
          deletions: 0,
        }
        const changesets = changed(3, 1, ".changeset/note-").map((file) => ({
          ...file,
          filename: file.filename.replace(/\.ts$/, ".md"),
        }))
        assert.strictEqual(yield* outcome([...changed(1, 9999), lockfile]), "runs")
        assert.strictEqual(yield* outcome([...changed(1, 10000), lockfile]), "runs")
        assert.strictEqual(yield* outcome(changed(1, 10001)), "skipped")
        assert.strictEqual(yield* outcome([...changed(99, 1), ...changesets]), "runs")
        assert.strictEqual(yield* outcome([...changed(100, 1), ...changesets]), "runs")
        assert.strictEqual(yield* outcome(changed(101, 1)), "skipped")

        const { runs } = yield* store.runs(repositoryId, { limit: 10, cursor: Option.none() })
        assert.deepStrictEqual(
          runs.map((run) => [
            run.status,
            run.status === "skipped" ? run.reason : null,
            run.trigger,
          ]),
          [
            ["skipped", "oversized", { _tag: "Automatic" }],
            ["skipped", "oversized", { _tag: "Automatic" }],
          ],
        )
        assert.isNotEmpty(github.checkRuns)
        for (const run of github.checkRuns)
          assert.deepStrictEqual(
            [run.headSha, run.status, run.conclusion],
            [HEAD, "completed", "neutral"],
          )
        assert.include(github.checkRuns.at(-1)!.output.summary, "/janitor")

        // A write-access /janitor forces the review, with the same limits.
        github.permissions.set("maintainer", { id: 31, permission: "write" })
        told.length = 0
        yield* admit({
          _tag: "Invoked",
          commentId: comment("502"),
          authorId: user("31"),
          authorLogin: "maintainer",
        })
        assert.deepStrictEqual(told, [
          {
            _tag: "Rerun",
            repositoryId: "701",
            number: 7,
            headSha: HEAD,
            trigger: { _tag: "Forced", invoker: "maintainer", commentId: "502" },
          },
        ])
      }),
  )
})
