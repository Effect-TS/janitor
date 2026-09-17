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
import { ContentPurge } from "../../src/ContentPurge.ts"
import { applyEvent } from "../../src/GitHub/ProjectWebhook.ts"
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
import { LabelingConfiguration } from "../../src/Labeling/Configuration.ts"
import { RepositoryEligibility } from "../../src/RepositoryEligibility.ts"
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
  webhookNow,
} from "./support.ts"

const Services = Layer.mergeAll(LabelItemLayer, LabelingAutomationIntegrationLayer).pipe(
  Layer.provideMerge(Layer.mergeAll(RepositoryEligibility.layer, ContentPurge.layer)),
  Layer.provideMerge(LabelingLayer),
  Layer.provideMerge(github.layer),
  Layer.provideMerge(WorkflowEngine.layerMemory),
  Layer.provideMerge(MigratedPostgresLayer),
)

let sequence = 100
/** One `issues` webhook delivery as the ingress projects it. */
const issueEvent = (issue: {
  number: number
  title: string
  state?: "open" | "closed"
  action?: string
  pullRequest?: boolean
}) =>
  Effect.gen(function* () {
    const event = yield* Schema.decodeUnknownEffect(GitHubWebhookEvent)({
      id: crypto.randomUUID(),
      name: "issues",
      payload: {
        action: issue.action ?? (issue.state === "closed" ? "closed" : "opened"),
        installation: { id: 77 },
        repository: { id: 701, full_name: "effect/one" },
        issue: {
          id: 1000 + issue.number,
          node_id: `I_${issue.number}`,
          number: issue.number,
          title: issue.title,
          body: null,
          state: issue.state ?? "open",
          user: { id: 9, login: "octocat" },
          labels: [],
          updated_at: new Date().toISOString(),
          ...(issue.pullRequest ? { pull_request: { url: "https://api.github.com/x" } } : {}),
        },
      },
    })
    const journal = GitHubWebhookJournalSequence.make(String(++sequence))
    yield* applyEvent(event, journal)
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

const titleIsHello = {
  target: "issue",
  matchesWhen: { fact: "title", operator: "equals", value: "Hello" },
} as const

layer(Services, { timeout: "2 minutes" })("Direct issue labeling", (it) => {
  it.effect("admits an open issue event without any synchronization", () =>
    Effect.gen(function* () {
      // Connected and eligible, but no track has ever synchronized.
      yield* seed
      github.labels = [{ id: 11, name: "bug" }]
      const policies = yield* Policies
      const rules = yield* LabelingRules
      const policy = yield* policies.create(
        repositoryId,
        { name: "Hello", description: "", source: titleIsHello },
        actor,
      )
      yield* policies.publish(repositoryId, policy.policy.policyId, policy.policy.version, actor)
      yield* rules.create(
        repositoryId,
        {
          labelId: bug,
          policyId: policy.policy.policyId,
          onMatch: "ensure-present",
          onNoMatch: "ensure-absent",
          group: null,
          priority: 0,
          enabled: true,
        },
        actor,
      )
      const journal = yield* issueEvent({ number: 16, title: "Hello" })
      const revision = (yield* Effect.flatMap(
        SqlClient.SqlClient,
        (sql) =>
          sql<{
            configured_revision: string
          }>`SELECT configured_revision::text FROM labeling_repository_rules WHERE repository_id=${repositoryId}`,
      ))[0]!.configured_revision
      assert.deepStrictEqual(
        (yield* queued).map((row) => row.execution_key),
        [`label-item:${repositoryId}:16:${journal}:${revision}`],
      )
      const entries = yield* activity
      assert.deepStrictEqual(
        entries.map((entry) => [entry.number, entry.outcome, entry.source]),
        [[16, null, "github"]],
      )
      // Admission is a local decision; GitHub is read when the work runs.
      assert.deepStrictEqual(github.requests, [])
    }),
  )

  it.effect("evaluates current GitHub facts, not the cached event, and writes the label", () =>
    Effect.gen(function* () {
      // The cache saw "Hello"; GitHub has since moved on. GitHub decides.
      github.put({ number: 16, title: "Goodbye", state: "open", labels: [] })
      const stale = yield* LabelItem.execute(yield* latestQueued)
      assert.strictEqual(stale.outcome, "evaluated")
      assert.deepStrictEqual(github.writes, [])
      const [entry] = yield* activity
      assert.deepStrictEqual(
        entry?.plan?.rules.map((rule) => [rule.outcome, rule.selected]),
        [["no-match", false]],
      )

      github.issues.get(16)!.title = "Hello"
      const journal = yield* issueEvent({ number: 16, title: "Hello", action: "edited" })
      const identity = yield* latestQueued
      assert.strictEqual(String(identity.snapshotGeneration), String(journal))
      const result = yield* LabelItem.execute(identity)
      assert.strictEqual(result.outcome, "evaluated")
      assert.deepStrictEqual(
        github.writes.map((request) => [request.method, request.url, request.body]),
        [["POST", "/repos/effect/one/issues/16/labels", { labels: ["bug"] }]],
      )
      assert.deepStrictEqual(
        github.issues.get(16)!.labels.map((label) => label.name),
        ["bug"],
      )
      const [applied] = yield* activity
      assert.strictEqual(applied?.detail, "1 change planned")
      assert.deepStrictEqual(
        applied?.actions.map((action) => [action.action, action.status, action.detail]),
        [["add", "applied", null]],
      )
      // Replaying the workflow returns the recorded outcome without another write.
      const again = yield* LabelItem.execute(identity)
      assert.strictEqual(again.outcome, "evaluated")
      assert.strictEqual(github.writes.length, 1)
    }),
  )

  it.effect("leaves closed issues outside labeling scope", () =>
    Effect.gen(function* () {
      const before = (yield* queued).length
      yield* issueEvent({ number: 17, title: "Hello", state: "closed" })
      assert.strictEqual((yield* queued).length, before)

      // Open when the event arrived, closed by the time the work runs.
      github.put({ number: 19, title: "Hello", state: "open", labels: [] })
      yield* issueEvent({ number: 19, title: "Hello" })
      github.issues.get(19)!.state = "closed"
      const writes = github.writes.length
      const result = yield* LabelItem.execute(yield* latestQueued)
      assert.strictEqual(result.outcome, "not-qualified")
      assert.strictEqual(github.writes.length, writes)
      const [entry] = yield* activity
      assert.deepStrictEqual([entry?.number, entry?.detail], [19, "issue is closed on GitHub"])
    }),
  )

  it.effect("hands work admitted under an older configuration to the latest revision", () =>
    Effect.gen(function* () {
      github.put({ number: 20, title: "Hello", state: "open", labels: [] })
      yield* issueEvent({ number: 20, title: "Hello" })
      const queuedBefore = yield* latestQueued
      const policies = yield* Policies
      const policy = (yield* policies.list(repositoryId))[0]!
      const saved = yield* policies.save(
        repositoryId,
        policy.policyId,
        {
          version: policy.version,
          source: {
            target: "issue",
            matchesWhen: { fact: "title", operator: "equals", value: "Nope" },
          },
        },
        actor,
      )
      const published = yield* policies.publish(
        repositoryId,
        policy.policyId,
        saved.policy.version,
        actor,
      )
      const writes = github.writes.length
      assert.strictEqual((yield* LabelItem.execute(queuedBefore)).outcome, "superseded")
      const latest = yield* latestQueued
      assert.isAbove(latest.rulesRevision, queuedBefore.rulesRevision)
      assert.strictEqual(latest.snapshotGeneration, queuedBefore.snapshotGeneration)
      const result = yield* LabelItem.execute(latest)
      assert.strictEqual(result.outcome, "evaluated")
      const [entry] = yield* activity
      assert.deepStrictEqual(
        entry?.plan?.rules.map((rule) => rule.outcome),
        ["no-match"],
      )
      assert.strictEqual(github.writes.length, writes)
      // Restore the matching policy for the remaining cases.
      const restored = yield* policies.save(
        repositoryId,
        policy.policyId,
        { version: published.policy.version, source: titleIsHello },
        actor,
      )
      yield* policies.publish(repositoryId, policy.policyId, restored.policy.version, actor)
    }),
  )

  it.effect("supersedes an older observation once a newer event exists, in any order", () =>
    Effect.gen(function* () {
      github.put({ number: 21, title: "Hello", state: "open", labels: [] })
      yield* issueEvent({ number: 21, title: "Hello" })
      const older = yield* latestQueued
      yield* issueEvent({ number: 21, title: "Hello", action: "edited" })
      const newer = yield* latestQueued
      assert.isTrue(BigInt(newer.snapshotGeneration) > BigInt(older.snapshotGeneration))
      const writes = github.writes.length
      // The newer event runs first; the older one then adds nothing.
      assert.strictEqual((yield* LabelItem.execute(newer)).outcome, "evaluated")
      assert.strictEqual(github.writes.length, writes + 1)
      assert.strictEqual((yield* LabelItem.execute(older)).outcome, "superseded")
      assert.strictEqual(github.writes.length, writes + 1)
    }),
  )

  it.effect("refuses work across a pause, even after the repository resumes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      github.put({ number: 22, title: "Hello", state: "open", labels: [] })
      yield* issueEvent({ number: 22, title: "Hello" })
      const paused = yield* latestQueued
      yield* sql`UPDATE github_repository SET enabled = FALSE WHERE repository_id = ${repositoryId}`
      // The pause discarded the pending row; work the engine already holds is refused too.
      assert.strictEqual((yield* queued).length, 0)
      const writes = github.writes.length
      const whilePaused = yield* LabelItem.execute(paused)
      assert.strictEqual(whilePaused.outcome, "not-qualified")
      assert.include((yield* activity)[0]?.detail, "paused")

      yield* sql`UPDATE github_repository SET enabled = TRUE WHERE repository_id = ${repositoryId}`
      github.put({ number: 23, title: "Hello", state: "open", labels: [] })
      yield* issueEvent({ number: 23, title: "Hello" })
      const admittedBeforePause = {
        ...(yield* latestQueued),
        eligibilityGeneration: paused.eligibilityGeneration,
      }
      yield* sql`DELETE FROM workflow_outbox WHERE workflow_tag = ${LABEL_ITEM_TAG}`
      const resumed = yield* LabelItem.execute(admittedBeforePause)
      assert.strictEqual(resumed.outcome, "not-qualified")
      assert.include((yield* activity)[0]?.detail, "changed since this work was accepted")
      assert.strictEqual(github.writes.length, writes)

      // A fresh event after resumption runs normally.
      yield* issueEvent({ number: 23, title: "Hello", action: "edited" })
      assert.strictEqual((yield* LabelItem.execute(yield* latestQueued)).outcome, "evaluated")
      assert.strictEqual(github.writes.length, writes + 1)
    }),
  )

  it.effect("waits for an in-flight write before a pause takes effect", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      github.put({ number: 28, title: "Hello", state: "open", labels: [] })
      yield* issueEvent({ number: 28, title: "Hello" })
      const identity = yield* latestQueued
      const writing = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      github.intercept = (request) =>
        request.method === "POST"
          ? Deferred.succeed(writing, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(undefined),
            )
          : Effect.succeed(undefined)
      const writes = github.writes.length
      const run = yield* LabelItem.execute(identity).pipe(
        Effect.forkChild({ startImmediately: true }),
      )
      yield* Deferred.await(writing)
      const pause =
        yield* sql`UPDATE github_repository SET enabled = FALSE WHERE repository_id = ${repositoryId}`.pipe(
          Effect.forkChild({ startImmediately: true }),
        )
      for (let i = 0; i < 5; i++) yield* Effect.yieldNow
      // The pause waits behind the fence held for the write attempt.
      const [during] = yield* sql<{ enabled: boolean }>`
        SELECT enabled FROM github_repository WHERE repository_id = ${repositoryId}`
      assert.strictEqual(during?.enabled, true)
      yield* Deferred.succeed(release, undefined)
      assert.strictEqual((yield* Fiber.join(run)).outcome, "evaluated")
      yield* Fiber.join(pause)
      github.intercept = () => Effect.succeed(undefined)
      assert.strictEqual(github.writes.length, writes + 1)
      assert.deepStrictEqual(
        (yield* activity)[0]?.actions.map((action) => action.status),
        ["applied"],
      )
      yield* sql`UPDATE github_repository SET enabled = TRUE WHERE repository_id = ${repositoryId}`
    }),
  )

  it.effect("ignores a failed synchronization track", () =>
    Effect.gen(function* () {
      const targets = yield* SyncTargets
      const labels = { _tag: "RepositoryTrack", repositoryId, track: "labels" } as const
      const { generation } = yield* targets.invalidate({ scope: labels, sequence: Option.none() })
      yield* targets.begin(labels, generation)
      yield* targets.complete({
        scope: labels,
        generation,
        outcome: { _tag: "Failed", error: "GitHub timeout" },
      })
      github.put({ number: 24, title: "Hello", state: "open", labels: [] })
      yield* issueEvent({ number: 24, title: "Hello" })
      const writes = github.writes.length
      assert.strictEqual((yield* LabelItem.execute(yield* latestQueued)).outcome, "evaluated")
      assert.strictEqual(github.writes.length, writes + 1)

      // An installation's cache setting is not an admission boundary: an
      // event received before the toggle is still admitted afterwards.
      const sql = yield* SqlClient.SqlClient
      const eligibility = yield* RepositoryEligibility
      const receivedAt = yield* webhookNow
      yield* sql`UPDATE github_installation SET sync_enabled = FALSE WHERE installation_id = ${installationId}`
      yield* sql`UPDATE github_installation SET sync_enabled = TRUE WHERE installation_id = ${installationId}`
      assert.isTrue(
        Option.isSome(
          yield* eligibility.admit(repositoryId, Effect.succeed("admitted"), receivedAt),
        ),
      )
      const before = (yield* queued).length
      yield* issueEvent({ number: 24, title: "Hello", action: "edited" })
      assert.strictEqual((yield* queued).length, before + 1)
      assert.strictEqual((yield* LabelItem.execute(yield* latestQueued)).outcome, "evaluated")
    }),
  )

  it.effect("reports unavailable facts and outages as failures, never as a non-match", () =>
    Effect.gen(function* () {
      // Present on GitHub with the label; the rule would remove it on a no-match.
      github.put({ number: 25, title: "Hello", state: "open", labels: [{ id: 11, name: "bug" }] })
      yield* issueEvent({ number: 25, title: "Hello" })
      const gone = yield* latestQueued
      github.issues.delete(25)
      const writes = github.writes.length
      assert.strictEqual((yield* LabelItem.execute(gone)).outcome, "failed")
      assert.include((yield* activity)[0]?.detail, "GitHub responded 404")

      github.put({ number: 25, title: "Hello", state: "open", labels: [{ id: 11, name: "bug" }] })
      yield* issueEvent({ number: 25, title: "Hello", action: "edited" })
      const outage = yield* latestQueued
      let attempts = 0
      github.intercept = (request) =>
        Effect.sync(() => {
          if (request.method !== "GET") return undefined
          attempts++
          return { _tag: "Failed" as const, status: 503, body: {}, requestId: Option.none() }
        })
      const fiber = yield* LabelItem.execute(outage).pipe(
        Effect.forkChild({ startImmediately: true }),
      )
      // Each failed read sleeps on the durable clock before the bounded retry.
      for (let tick = 0; attempts < 4 && tick < 50; tick++) {
        yield* Effect.yieldNow
        yield* TestClock.adjust("20 seconds")
      }
      const result = yield* Fiber.join(fiber)
      assert.strictEqual(attempts, 4)
      github.intercept = () => Effect.succeed(undefined)
      assert.strictEqual(result.outcome, "failed")
      assert.include((yield* activity)[0]?.detail, "GitHub responded 503")
      assert.strictEqual(github.writes.length, writes)
    }),
  )

  it.effect("waits out a GitHub throttle before reading and writing", () =>
    Effect.gen(function* () {
      github.put({ number: 26, title: "Hello", state: "open", labels: [] })
      yield* issueEvent({ number: 26, title: "Hello" })
      const identity = yield* latestQueued
      const start = yield* DateTime.now
      const until = DateTime.addDuration(start, "30 seconds")
      const throttled = yield* Deferred.make<void>()
      let limited = 0
      github.intercept = (request) =>
        request.url.endsWith("/issues/26") && limited++ === 0
          ? Deferred.succeed(throttled, undefined).pipe(
              Effect.andThen(
                Effect.fail(new GitHubRateLimited({ scopeKey: "i:77", until, reason: "reserve" })),
              ),
            )
          : Effect.succeed(undefined)
      const writes = github.writes.length
      const fiber = yield* LabelItem.execute(identity).pipe(
        Effect.forkChild({ startImmediately: true }),
      )
      yield* Deferred.await(throttled)
      yield* TestClock.adjust("29 seconds")
      assert.strictEqual(github.writes.length, writes)
      yield* TestClock.adjust("2 seconds")
      const result = yield* Fiber.join(fiber)
      github.intercept = () => Effect.succeed(undefined)
      assert.strictEqual(result.outcome, "evaluated")
      assert.strictEqual(github.writes.length, writes + 1)
    }),
  )

  it.effect("previews issues from GitHub", () =>
    Effect.gen(function* () {
      const bench = yield* LabelingTest
      // The cache still holds the webhook titles; GitHub has the current ones.
      github.issues.get(16)!.title = "Hello again"
      github.issues.get(16)!.labels = [{ id: 11, name: "bug" }]
      const items = yield* bench.items(repositoryId)
      const sixteen = items.find((item) => item.number === 16)
      assert.deepStrictEqual(
        [sixteen?.title, sixteen?.source, sixteen?.labels, sixteen?.labelNames],
        ["Hello again", "github", ["11"], { "11": "bug" }],
      )
      // Closed on GitHub: not an open item, whatever the cache says.
      assert.isUndefined(items.find((item) => item.number === 19))

      const preview = yield* bench.run(repositoryId, {
        subject: { _tag: "Configuration" },
        numbers: [16, 19],
      })
      assert.strictEqual(preview._tag, "Evaluated")
      if (preview._tag !== "Evaluated") return
      assert.deepStrictEqual(
        preview.entities.map((entity) => [entity.number, entity.source]),
        [[16, "github"]],
      )
      // "Hello again" no longer matches; the rule would remove the label, but tests never write.
      assert.deepStrictEqual(
        preview.entities[0]?.plan?.actions.map((action) => [action.labelId, action.action]),
        [[bug, "remove"]],
      )
      github.issues.get(16)!.title = "Hello"
    }),
  )

  it.effect("retires rules bound to a label GitHub no longer has", () =>
    Effect.gen(function* () {
      const policies = yield* Policies
      const rules = yield* LabelingRules
      const policy = yield* policies.create(
        repositoryId,
        { name: "Hello too", description: "", source: titleIsHello },
        actor,
      )
      yield* policies.publish(repositoryId, policy.policy.policyId, policy.policy.version, actor)
      const rule = yield* rules.create(
        repositoryId,
        {
          labelId: feature,
          policyId: policy.policy.policyId,
          onMatch: "ensure-present",
          onNoMatch: "no-action",
          group: null,
          priority: 0,
          enabled: true,
        },
        actor,
      )
      const configuration = yield* LabelingConfiguration
      const revision = (yield* configuration.view(repositoryId)).configuredRevision
      github.put({ number: 27, title: "Hello", state: "open", labels: [] })
      yield* issueEvent({ number: 27, title: "Hello" })
      const result = yield* LabelItem.execute(yield* latestQueued)
      assert.strictEqual(result.outcome, "evaluated")
      const [entry] = yield* activity
      assert.deepStrictEqual(
        entry?.actions.map((action) => [action.labelId, action.status, action.detail]).sort(),
        [
          [bug, "applied", null],
          [feature, "failed", "label is missing on GitHub"],
        ],
      )
      const retired = (yield* rules.list(repositoryId)).find(
        (candidate) => candidate.id === rule.id,
      )
      assert.deepStrictEqual([retired?.enabled, retired?.labelStatus], [false, "missing"])
      assert.isAbove((yield* configuration.view(repositoryId)).configuredRevision, revision)
    }),
  )
})
