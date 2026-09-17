import { assert, layer } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as TestClock from "effect/testing/TestClock"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import { GitHubWebhookEvent } from "@janitor/domain/GitHub/WebhookEvent"
import { GitHubWebhookJournalSequence } from "@janitor/domain/GitHub/WebhookJournal"
import type { ProgramSource } from "@janitor/domain/Labeling/Policy/Program"
import { ContentPurge } from "../../src/ContentPurge.ts"
import { applyEvent } from "../../src/GitHub/ProjectWebhook.ts"
import { GitHubReadModel } from "../../src/GitHub/ReadModel.ts"
import { GitHubRateLimited } from "../../src/GitHub/Transport.ts"
import { activityPage } from "../../src/Labeling/Activity.ts"
import { LabelingAutomationIntegrationLayer } from "../../src/Labeling/AutomationIntegration.ts"
import {
  DirectLabelingIdentity,
  LABEL_ITEM_TAG,
  LabelItem,
  LabelItemLayer,
} from "../../src/Labeling/DirectLabeling.ts"
import { Policies } from "../../src/Labeling/Policies.ts"
import { LabelingRules } from "../../src/Labeling/Rules.ts"
import { LabelingTest } from "../../src/Labeling/Test.ts"
import { SyncTargets } from "../../src/SyncTargets.ts"
import { MigratedPostgresLayer } from "../support/Postgres.ts"
import {
  actor,
  bug,
  feature,
  github,
  installationId,
  LabelingLayer,
  repositoryId,
  seed,
  seedPullRequests,
  webhookNow,
} from "./support.ts"

const Services = Layer.mergeAll(LabelItemLayer, LabelingAutomationIntegrationLayer).pipe(
  Layer.provideMerge(ContentPurge.layer),
  Layer.provideMerge(LabelingLayer),
  Layer.provideMerge(github.layer),
  Layer.provideMerge(WorkflowEngine.layerMemory),
  Layer.provideMerge(MigratedPostgresLayer),
)

let sequence = 200
/** One `pull_request` webhook delivery as the ingress projects it. */
const pullRequestEvent = (pull: {
  number: number
  title?: string
  action?: string
  state?: "open" | "closed"
  merged?: boolean
  draft?: boolean
  baseRef?: string
  receivedAt?: Date
}) =>
  Effect.gen(function* () {
    const action = pull.action ?? (pull.state === "closed" ? "closed" : "opened")
    const event = yield* Schema.decodeUnknownEffect(GitHubWebhookEvent)({
      id: crypto.randomUUID(),
      name: "pull_request",
      payload: {
        action,
        ...(action === "edited" ? { changes: {} } : {}),
        ...(action === "synchronize" ? { before: "b".repeat(40), after: "a".repeat(40) } : {}),
        number: pull.number,
        installation: { id: 77 },
        repository: { id: 701, full_name: "effect/one" },
        sender: { id: 9, login: "octocat" },
        pull_request: {
          id: 2000 + pull.number,
          node_id: `PR_${pull.number}`,
          number: pull.number,
          title: pull.title ?? `Change ${pull.number}`,
          body: null,
          state: pull.state ?? "open",
          draft: pull.draft ?? false,
          merged: pull.merged ?? false,
          updated_at: new Date().toISOString(),
          labels: [],
          user: { id: 9, login: "octocat" },
          head: { sha: "a".repeat(40) },
          base: { ref: pull.baseRef ?? "main" },
        },
      },
    })
    const journal = GitHubWebhookJournalSequence.make(String(++sequence))
    yield* applyEvent(event, journal, pull.receivedAt ?? (yield* webhookNow))
    return journal
  })

const queued = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql<{ execution_key: string }>`
    SELECT execution_key FROM workflow_outbox WHERE workflow_tag = ${LABEL_ITEM_TAG}
    ORDER BY execution_key
  `,
)

const latestQueued = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<{ payload: unknown }>`
    SELECT payload FROM workflow_outbox WHERE workflow_tag = ${LABEL_ITEM_TAG}
    ORDER BY (payload->>'snapshotGeneration')::bigint DESC, (payload->>'rulesRevision')::bigint DESC LIMIT 1
  `
  return yield* Schema.decodeUnknownEffect(DirectLabelingIdentity)(row?.payload)
})

const activity = activityPage(repositoryId, { search: "", target: "all", cursor: null }).pipe(
  Effect.map((page) => page.entries),
)

const baseMain: ProgramSource = {
  target: "pull_request",
  matchesWhen: { fact: "baseRef", operator: "equals", value: "main" },
}
const touchesSource: ProgramSource = {
  target: "pull_request",
  matchesWhen: {
    some: "changedFiles",
    where: { fact: "path", operator: "matchesGlob", value: "src/**" },
  },
}

const publishRule = (
  name: string,
  source: ProgramSource,
  labelId: typeof bug,
  onNoMatch: "ensure-absent" | "no-action",
) =>
  Effect.gen(function* () {
    const policies = yield* Policies
    const rules = yield* LabelingRules
    const policy = yield* policies.create(repositoryId, { name, description: "", source }, actor)
    yield* policies.publish(repositoryId, policy.policy.policyId, policy.policy.version, actor)
    return yield* rules.create(
      repositoryId,
      {
        labelId,
        policyId: policy.policy.policyId,
        onMatch: "ensure-present",
        onNoMatch,
        group: null,
        priority: 0,
        enabled: true,
      },
      actor,
    )
  })

layer(Services, { timeout: "2 minutes" })("Direct pull request labeling", (it) => {
  it.effect(
    "admits open pull request events without any synchronization and skips closed ones",
    () =>
      Effect.gen(function* () {
        // Connected and eligible, but no track has ever synchronized and the
        // cache knows nothing about the pull requests GitHub holds.
        yield* seed
        github.put({
          number: 5,
          title: "Change 5",
          state: "open",
          labels: [],
          pullRequest: { baseRef: "main", files: [{ filename: "src/a.ts", status: "modified" }] },
        })
        yield* publishRule("Base is main", baseMain, bug, "ensure-absent")
        const journal = yield* pullRequestEvent({ number: 5 })
        const revision = (yield* Effect.flatMap(
          SqlClient.SqlClient,
          (sql) =>
            sql<{
              configured_revision: string
            }>`SELECT configured_revision::text FROM labeling_repository_rules WHERE repository_id=${repositoryId}`,
        ))[0]!.configured_revision
        assert.deepStrictEqual(
          (yield* queued).map((row) => row.execution_key),
          [`label-item:${repositoryId}:5:${journal}:${revision}`],
        )
        // Closed and merged pull requests are outside labeling scope.
        yield* pullRequestEvent({ number: 7, state: "closed" })
        yield* pullRequestEvent({ number: 8, state: "closed", merged: true, action: "closed" })
        assert.strictEqual((yield* queued).length, 1)
        // Admission is a local decision; GitHub is read when the work runs.
        assert.deepStrictEqual(github.requests, [])
      }),
  )

  it.effect(
    "evaluates the pull request GitHub describes, not the cached one, and writes the label",
    () =>
      Effect.gen(function* () {
        // The webhook said "main"; GitHub has since retargeted the pull request.
        github.pull(5)!.baseRef = "develop"
        const retargeted = yield* LabelItem.execute(yield* latestQueued)
        assert.strictEqual(retargeted.outcome, "evaluated")
        assert.deepStrictEqual(github.writes, [])
        assert.deepStrictEqual(
          (yield* activity)[0]?.plan?.rules.map((rule) => [rule.outcome, rule.selected]),
          [["no-match", false]],
        )

        github.pull(5)!.baseRef = "main"
        yield* pullRequestEvent({ number: 5, action: "edited", baseRef: "develop" })
        const identity = yield* latestQueued
        const result = yield* LabelItem.execute(identity)
        assert.strictEqual(result.outcome, "evaluated")
        assert.deepStrictEqual(
          github.writes.map((request) => [request.method, request.url, request.body]),
          [["POST", "/repos/effect/one/issues/5/labels", { labels: ["bug"] }]],
        )
        assert.deepStrictEqual(
          github.issues.get(5)!.labels.map((label) => label.name),
          ["bug"],
        )
        // The rule reads no collection, so none was fetched.
        assert.isFalse(github.reads.some((request) => request.url.includes("/files")))
        // Replaying the workflow returns the recorded outcome without another write.
        assert.strictEqual((yield* LabelItem.execute(identity)).outcome, "evaluated")
        assert.strictEqual(github.writes.length, 1)
      }),
  )

  it.effect("reads paginated collections and treats an unavailable one as unknown", () =>
    Effect.gen(function* () {
      const rule = yield* publishRule("Touches source", touchesSource, feature, "ensure-absent")
      github.pull(5)!.files = Array.from({ length: 150 }, (_, index) => ({
        filename: index === 149 ? "src/last.ts" : `docs/${index}.md`,
        status: "modified",
      }))
      yield* pullRequestEvent({ number: 5, action: "synchronize" })
      const writes = github.writes.length
      assert.strictEqual((yield* LabelItem.execute(yield* latestQueued)).outcome, "evaluated")
      // The matching file sits on the second page.
      assert.strictEqual(
        github.reads.filter((request) => request.url.includes("/pulls/5/files")).length,
        2,
      )
      assert.deepStrictEqual(
        github.writes.slice(writes).map((request) => [request.method, request.body]),
        [["POST", { labels: ["feature"] }]],
      )

      // GitHub reports more files than it lists: the fact is unavailable, the
      // rule is unknown, and the label it owns stays as it is.
      github.pull(5)!.changedFiles = 5000
      yield* pullRequestEvent({ number: 5, action: "synchronize" })
      assert.strictEqual((yield* LabelItem.execute(yield* latestQueued)).outcome, "evaluated")
      const [entry] = yield* activity
      const baseRule = (yield* (yield* LabelingRules).list(repositoryId)).find(
        (candidate) => candidate.labelId === bug,
      )
      assert.deepStrictEqual(
        entry?.evaluations?.map((evaluation) => [evaluation.ruleId, evaluation.outcome]).sort(),
        [
          [baseRule?.id, "match"],
          [rule.id, "unknown"],
        ].sort(),
      )
      assert.strictEqual(github.writes.length, writes + 1)
      delete github.pull(5)!.changedFiles
    }),
  )

  it.effect("leaves a pull request closed or merged by run time or write time alone", () =>
    Effect.gen(function* () {
      github.put({ number: 9, title: "Change 9", state: "open", labels: [], pullRequest: {} })
      yield* pullRequestEvent({ number: 9 })
      github.pull(9)!.merged = true
      github.issues.get(9)!.state = "closed"
      const writes = github.writes.length
      const merged = yield* LabelItem.execute(yield* latestQueued)
      assert.strictEqual(merged.outcome, "not-qualified")
      assert.strictEqual((yield* activity)[0]?.detail, "pull request is closed or merged on GitHub")

      // Open while evaluating, merged before the write attempt.
      github.put({ number: 10, title: "Change 10", state: "open", labels: [], pullRequest: {} })
      yield* pullRequestEvent({ number: 10 })
      // The evaluation read the open pull request; the write attempt rereads a merged one.
      let reads = 0
      github.intercept = (request) =>
        Effect.sync(() => {
          if (request.method === "GET" && request.url.endsWith("/issues/10") && ++reads === 2) {
            github.pull(10)!.merged = true
            github.issues.get(10)!.state = "closed"
          }
          return undefined
        })
      const late = yield* LabelItem.execute(yield* latestQueued)
      github.intercept = () => Effect.succeed(undefined)
      assert.strictEqual(late.outcome, "evaluated")
      assert.strictEqual(github.writes.length, writes)
      assert.deepStrictEqual(
        (yield* activity)[0]?.actions.map((action) => [action.status, action.detail]),
        [["failed", "pull request is closed or merged on GitHub"]],
      )
    }),
  )

  it.effect("refuses work once repository access is lost, even after restoration", () =>
    Effect.gen(function* () {
      const readModel = yield* GitHubReadModel
      github.put({ number: 11, title: "Change 11", state: "open", labels: [], pullRequest: {} })
      yield* pullRequestEvent({ number: 11 })
      const identity = yield* latestQueued
      const writes = github.writes.length
      const repositories = [
        { id: repositoryId, fullName: { owner: "effect", repo: "one" }, isPrivate: false },
      ]
      yield* readModel.markRepositoriesLost({
        installationId,
        repositories,
        sequence: GitHubWebhookJournalSequence.make("900"),
      })
      // Access loss discards the pending row; work the engine already holds is refused.
      assert.strictEqual((yield* queued).length, 0)
      assert.strictEqual((yield* LabelItem.execute(identity)).outcome, "not-qualified")
      yield* readModel.applyRepositories({
        installationId,
        repositories,
        sequence: GitHubWebhookJournalSequence.make("901"),
      })
      yield* pullRequestEvent({ number: 11, action: "edited" })
      const stale = {
        ...(yield* latestQueued),
        eligibilityGeneration: identity.eligibilityGeneration,
      }
      yield* Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`DELETE FROM workflow_outbox WHERE workflow_tag = ${LABEL_ITEM_TAG}`,
      )
      assert.strictEqual((yield* LabelItem.execute(stale)).outcome, "not-qualified")
      assert.include((yield* activity)[0]?.detail, "changed since this work was accepted")
      assert.strictEqual(github.writes.length, writes)
      // A fresh event after restoration runs normally.
      yield* pullRequestEvent({ number: 11, action: "reopened" })
      assert.strictEqual((yield* LabelItem.execute(yield* latestQueued)).outcome, "evaluated")
      assert.strictEqual(github.writes.length, writes + 1)
    }),
  )

  it.effect("ignores failed synchronization and stale cached facts", () =>
    Effect.gen(function* () {
      const targets = yield* SyncTargets
      for (const track of ["labels", "entities", "pull_requests"] as const) {
        const scope = { _tag: "RepositoryTrack", repositoryId, track } as const
        const { generation } = yield* targets.invalidate({ scope, sequence: Option.none() })
        yield* targets.begin(scope, generation)
        yield* targets.complete({
          scope,
          generation,
          outcome: { _tag: "Failed", error: "GitHub timeout" },
        })
      }
      // The cache still believes #6 targets develop; GitHub says main.
      yield* seedPullRequests
      github.pull(6)!.baseRef = "main"
      yield* pullRequestEvent({ number: 6, baseRef: "develop" })
      const writes = github.writes.length
      assert.strictEqual((yield* LabelItem.execute(yield* latestQueued)).outcome, "evaluated")
      assert.deepStrictEqual(
        github.writes.slice(writes).map((request) => [request.url, request.body]),
        [["/repos/effect/one/issues/6/labels", { labels: ["bug"] }]],
      )
    }),
  )

  it.effect("waits out a throttle and reports an outage as a failure, never a non-match", () =>
    Effect.gen(function* () {
      github.put({
        number: 12,
        title: "Change 12",
        state: "open",
        labels: [{ id: 11, name: "bug" }],
        pullRequest: { baseRef: "develop" },
      })
      yield* pullRequestEvent({ number: 12, baseRef: "develop" })
      const throttled = yield* Deferred.make<void>()
      const until = DateTime.addDuration(yield* DateTime.now, "30 seconds")
      let limited = 0
      github.intercept = (request) =>
        request.url.endsWith("/pulls/12") && limited++ === 0
          ? Deferred.succeed(throttled, undefined).pipe(
              Effect.andThen(
                Effect.fail(new GitHubRateLimited({ scopeKey: "i:77", until, reason: "reserve" })),
              ),
            )
          : Effect.succeed(undefined)
      const writes = github.writes.length
      const fiber = yield* LabelItem.execute(yield* latestQueued).pipe(
        Effect.forkChild({ startImmediately: true }),
      )
      yield* Deferred.await(throttled)
      yield* TestClock.adjust("29 seconds")
      assert.strictEqual(github.writes.length, writes)
      yield* TestClock.adjust("2 seconds")
      assert.strictEqual((yield* Fiber.join(fiber)).outcome, "evaluated")
      // Base is develop: the rule removes the label it owns.
      assert.deepStrictEqual(
        github.writes.slice(writes).map((request) => request.method),
        ["DELETE"],
      )

      github.issues.get(12)!.labels = [{ id: 11, name: "bug" }]
      yield* pullRequestEvent({ number: 12, action: "synchronize", baseRef: "develop" })
      let attempts = 0
      github.intercept = (request) =>
        Effect.sync(() => {
          if (!request.url.endsWith("/pulls/12")) return undefined
          attempts++
          return { _tag: "Failed" as const, status: 503, body: {}, requestId: Option.none() }
        })
      const outage = yield* LabelItem.execute(yield* latestQueued).pipe(
        Effect.forkChild({ startImmediately: true }),
      )
      for (let tick = 0; attempts < 4 && tick < 50; tick++) {
        yield* Effect.yieldNow
        yield* TestClock.adjust("20 seconds")
      }
      const result = yield* Fiber.join(outage)
      github.intercept = () => Effect.succeed(undefined)
      assert.strictEqual(attempts, 4)
      assert.strictEqual(result.outcome, "failed")
      assert.include((yield* activity)[0]?.detail, "GitHub responded 503")
      assert.deepStrictEqual(
        github.issues.get(12)!.labels.map((label) => label.name),
        ["bug"],
      )
    }),
  )

  it.effect("previews pull requests from GitHub with their evidence and proposed effects", () =>
    Effect.gen(function* () {
      const bench = yield* LabelingTest
      github.pull(5)!.draft = true
      github.pull(5)!.files = [{ filename: "src/a.ts", status: "modified" }]
      github.issues.get(5)!.labels = [{ id: 11, name: "bug" }]
      github.requests.length = 0
      const items = yield* bench.items(repositoryId)
      const five = items.find((item) => item.number === 5)
      assert.deepStrictEqual(
        [five?.kind, five?.baseRef, five?.draft, five?.source, five?.labelNames],
        ["pull_request", "main", true, "github", { "11": "bug" }],
      )
      // Listing needs no collections; a preview reads only what its subject needs.
      assert.isFalse(github.reads.some((request) => request.url.includes("/pulls/5/files")))
      const writes = github.writes.length
      const preview = yield* bench.run(repositoryId, {
        subject: { _tag: "Draft", source: touchesSource },
        numbers: [5, 9],
      })
      assert.strictEqual(preview._tag, "Evaluated")
      if (preview._tag !== "Evaluated") return
      // #9 is merged: not an open item, whatever the event said.
      assert.deepStrictEqual(
        preview.entities.map((entity) => [entity.number, entity.evaluation?.outcome]),
        [[5, "match"]],
      )
      assert.isTrue(github.reads.some((request) => request.url.includes("/pulls/5/files")))
      const configured = yield* bench.run(repositoryId, {
        subject: { _tag: "Configuration" },
        numbers: [5],
      })
      assert.strictEqual(configured._tag, "Evaluated")
      if (configured._tag !== "Evaluated") return
      github.pull(5)!.draft = false
      github.issues.get(5)!.labels = []
      const changed = yield* bench.run(repositoryId, {
        subject: { _tag: "Configuration" },
        numbers: [5],
      })
      assert.strictEqual(changed._tag, "Evaluated")
      if (changed._tag !== "Evaluated") return
      assert.deepStrictEqual(
        changed.entities[0]?.plan?.actions.map((action) => [action.labelId, action.action]).sort(),
        [
          [bug, "add"],
          [feature, "add"],
        ],
      )
      assert.strictEqual(github.writes.length, writes)
    }),
  )
})
