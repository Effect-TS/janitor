import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { GitHubWebhookEvent } from "@janitor/domain/GitHub/WebhookEvent"
import { GitHubWebhookJournalSequence } from "@janitor/domain/GitHub/WebhookJournal"
import { applyEvent } from "../../src/GitHub/ProjectWebhook.ts"
import { GitHubReadModel } from "../../src/GitHub/ReadModel.ts"
import { ContentPurge } from "../../src/ContentPurge.ts"
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import { GitHubTransport, type GitHubRequest } from "../../src/GitHub/Transport.ts"
import { Policies } from "../../src/Labeling/Policies.ts"
import { LabelingRules } from "../../src/Labeling/Rules.ts"
import { SnapshotHandoff } from "../../src/Labeling/SnapshotHandoff.ts"
import { ReconcileEntity, ReconcileEntityLayer } from "../../src/Labeling/ReconcileEntity.ts"
import { SyncTargets } from "../../src/SyncTargets.ts"
import {
  Services,
  actor,
  baseMain,
  bug,
  repositoryId,
  seed,
  seedPullRequests,
  seq,
  verifyTrack,
} from "./support.ts"

const writes: Array<GitHubRequest> = []
const services = Layer.mergeAll(ReconcileEntityLayer, ContentPurge.layer).pipe(
  Layer.provideMerge(Services),
  Layer.provideMerge(WorkflowEngine.layerMemory),
  Layer.provide(
    Layer.succeed(GitHubTransport, {
      request: (request) =>
        Effect.sync(() => {
          writes.push(request)
          return {
            _tag: "Ok" as const,
            status: 200,
            body: {},
            etag: Option.none(),
            link: Option.none(),
            requestId: Option.none(),
          }
        }),
    }),
  ),
)
layer(services, { timeout: "2 minutes" })("Labeling readiness", (it) => {
  it.effect("admits only new open-item events after synchronization recovery", () =>
    Effect.gen(function* () {
      yield* seed
      yield* seedPullRequests
      for (const track of ["labels", "entities", "pull_requests"] as const)
        yield* verifyTrack(track)
      const policies = yield* Policies
      const rules = yield* LabelingRules
      const draft = yield* policies.create(
        repositoryId,
        { name: "Main", description: "", source: baseMain },
        actor,
      )
      yield* policies.publish(repositoryId, draft.policy.policyId, draft.policy.version, actor)
      yield* rules.create(
        repositoryId,
        {
          policyId: draft.policy.policyId,
          labelId: bug,
          onMatch: "ensure-present",
          onNoMatch: "no-action",
          group: null,
          priority: 0,
          enabled: true,
        },
        actor,
      )
      const targets = yield* SyncTargets
      const scope = { _tag: "Entity", repositoryId, number: 5 } as const
      const { generation } = yield* targets.invalidate({ scope, sequence: Option.none() })
      yield* targets.begin(scope, generation)
      yield* targets.complete({
        scope,
        generation,
        outcome: { _tag: "Verified", watermark: Option.none() },
      })
      const result = yield* (yield* SnapshotHandoff).publish({
        repositoryId,
        number: 5,
        generation,
        sequence: seq,
      })
      assert.strictEqual(result._tag, "Skipped")
      if (result._tag === "Published") yield* ReconcileEntity.execute(result.identity)
      assert.deepStrictEqual(writes, [])
      const refresh = (webhookReceivedAt?: Date, number = 5) =>
        Effect.gen(function* () {
          const scope = { _tag: "Entity", repositoryId, number } as const
          const { generation } = yield* targets.invalidate({
            scope,
            sequence: Option.some(seq),
            webhookReceivedAt,
          })
          const target = Option.getOrThrow(yield* targets.get(scope))
          yield* targets.begin(scope, target.dispatchedGeneration)
          yield* targets.complete({
            scope,
            generation,
            outcome: { _tag: "Verified", watermark: Option.none() },
          })
          return yield* (yield* SnapshotHandoff).publish({
            repositoryId,
            number,
            generation,
            sequence: seq,
          })
        })
      const queued = yield* refresh(new Date())
      assert.strictEqual(queued._tag, "Published")
      const labels = { _tag: "RepositoryTrack", repositoryId, track: "labels" } as const
      const failure = yield* targets.invalidate({ scope: labels, sequence: Option.none() })
      yield* targets.begin(labels, failure.generation)
      yield* targets.complete({
        scope: labels,
        generation: failure.generation,
        outcome: { _tag: "Failed", error: "GitHub timeout" },
      })
      const blockedAt = new Date()
      assert.strictEqual((yield* refresh(blockedAt, 6))._tag, "Skipped")
      yield* targets.invalidate({ scope: labels, sequence: Option.none() })
      yield* verifyTrack("labels")
      if (queued._tag === "Published") yield* ReconcileEntity.execute(queued.identity)
      assert.deepStrictEqual(writes, [])
      assert.strictEqual((yield* refresh(blockedAt))._tag, "Skipped")
      assert.strictEqual((yield* refresh())._tag, "Skipped")
      const fresh = yield* refresh(new Date())
      assert.strictEqual(fresh._tag, "Published")
      if (fresh._tag === "Published") yield* ReconcileEntity.execute(fresh.identity)
      assert.deepStrictEqual(
        writes.map((request) => [request.method, request.url]),
        [["POST", "/repos/effect/one/issues/5/labels"]],
      )
      const issuePolicy = yield* policies.create(
        repositoryId,
        {
          name: "Issues",
          description: "",
          source: {
            target: "issue",
            matchesWhen: { fact: "title", operator: "equals", value: "Hello" },
          },
        },
        actor,
      )
      yield* policies.publish(
        repositoryId,
        issuePolicy.policy.policyId,
        issuePolicy.policy.version,
        actor,
      )
      yield* rules.create(
        repositoryId,
        {
          policyId: issuePolicy.policy.policyId,
          labelId: bug,
          onMatch: "ensure-present",
          onNoMatch: "no-action",
          group: null,
          priority: 0,
          enabled: true,
        },
        actor,
      )
      const issueEvent = (state: "open" | "closed", sequence: string) =>
        Effect.gen(function* () {
          const event = yield* Schema.decodeUnknownEffect(GitHubWebhookEvent)({
            id: crypto.randomUUID(),
            name: "issues",
            payload: {
              action: state === "open" ? "opened" : "closed",
              installation: { id: 77 },
              repository: { id: 701, full_name: "effect/one" },
              issue: {
                id: 1016,
                node_id: "I_16",
                number: 16,
                title: "Hello",
                body: null,
                state,
                user: { id: 9, login: "octocat" },
                labels: [],
                updated_at: new Date().toISOString(),
              },
            },
          })
          yield* applyEvent(event, GitHubWebhookJournalSequence.make(sequence), new Date())
        })
      yield* issueEvent("open", "10")
      const issueScope = { _tag: "Entity", repositoryId, number: 16 } as const
      const finishIssue = Effect.gen(function* () {
        const target = Option.getOrThrow(yield* targets.get(issueScope))
        const run = yield* targets.begin(issueScope, target.dispatchedGeneration)
        if (run._tag !== "Run") return yield* Effect.die("Expected an issue refresh")
        yield* targets.complete({
          scope: issueScope,
          generation: run.generation,
          outcome: { _tag: "Verified", watermark: Option.none() },
        })
        return yield* (yield* SnapshotHandoff).publish({
          repositoryId,
          number: 16,
          generation: run.generation,
          sequence: seq,
        })
      })
      const queuedIssue = yield* finishIssue
      assert.strictEqual(queuedIssue._tag, "Published")
      yield* issueEvent("closed", "11")
      if (queuedIssue._tag === "Published") yield* ReconcileEntity.execute(queuedIssue.identity)
      assert.strictEqual((yield* finishIssue)._tag, "Skipped")
      assert.strictEqual(
        Option.getOrThrow(yield* (yield* GitHubReadModel).getEntity(repositoryId, 16)).entity.state,
        "closed",
      )
      assert.strictEqual(writes.length, 1)
      yield* issueEvent("open", "12")
      const reopened = yield* finishIssue
      assert.strictEqual(reopened._tag, "Published")
      if (reopened._tag === "Published") yield* ReconcileEntity.execute(reopened.identity)
      assert.deepStrictEqual(
        writes.map((request) => request.url),
        ["/repos/effect/one/issues/5/labels", "/repos/effect/one/issues/16/labels"],
      )
      const pullEvent = (merged: boolean, sequence: string) =>
        Effect.gen(function* () {
          const event = yield* Schema.decodeUnknownEffect(GitHubWebhookEvent)({
            id: crypto.randomUUID(),
            name: "pull_request",
            payload: {
              action: merged ? "closed" : "opened",
              number: 5,
              installation: { id: 77 },
              repository: { id: 701, full_name: "effect/one" },
              sender: { id: 9, login: "octocat" },
              pull_request: {
                id: 2005,
                node_id: "PR_5",
                number: 5,
                title: "Change 5",
                body: null,
                state: merged ? "closed" : "open",
                draft: false,
                merged,
                updated_at: new Date().toISOString(),
                labels: [],
                user: { id: 9, login: "octocat" },
                head: { sha: "a".repeat(40) },
                base: { ref: "main" },
              },
            },
          })
          yield* applyEvent(event, GitHubWebhookJournalSequence.make(sequence), new Date())
        })
      yield* pullEvent(false, "20")
      const beforeMerge = yield* refresh(new Date())
      assert.strictEqual(beforeMerge._tag, "Published")
      yield* pullEvent(true, "21")
      if (beforeMerge._tag === "Published") yield* ReconcileEntity.execute(beforeMerge.identity)
      assert.strictEqual((yield* refresh(new Date()))._tag, "Skipped")
      assert.strictEqual(writes.length, 2)
    }),
  )
})
