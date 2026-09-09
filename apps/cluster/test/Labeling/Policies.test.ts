import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { LabelingRevision } from "@janitor/domain/Labeling/Policy/Configuration"
import type { ProgramSource } from "@janitor/domain/Labeling/Policy/Program"
import { RulesetActivation } from "../../src/Labeling/Activation.ts"
import { LabelingConfiguration } from "../../src/Labeling/Configuration.ts"
import { GitHubReadModel } from "../../src/GitHub/ReadModel.ts"
import { Policies } from "../../src/Labeling/Policies.ts"
import { LabelingRules } from "../../src/Labeling/Rules.ts"
import { LabelingTest } from "../../src/Labeling/Test.ts"
import {
  actor,
  baseMain,
  bug,
  repositoryId,
  seed,
  seedPullRequests,
  Services,
  verifyTrack,
} from "./support.ts"

layer(Services, { timeout: "2 minutes" })("Policies and rules against Postgres", (it) => {
  it.effect("creates, publishes, binds, and activates through the configuration revision", () =>
    Effect.gen(function* () {
      yield* seed
      yield* seedPullRequests
      const policies = yield* Policies
      const rules = yield* LabelingRules
      const configuration = yield* LabelingConfiguration
      const activation = yield* RulesetActivation

      const empty = yield* configuration.view(repositoryId)
      assert.strictEqual(empty.configuredRevision, 0)
      assert.deepStrictEqual(
        empty.labels.map((label) => label.name),
        ["bug", "feature"],
      )

      // A draft is not live: nothing advances until it publishes.
      const created = yield* policies.create(
        repositoryId,
        { name: "Base is main", description: "", source: baseMain },
        actor,
      )
      assert.strictEqual(created.policy.version, 1)
      assert.isNull(created.published)
      assert.deepStrictEqual(created.draft, {
        target: "pull_request",
        matchesWhen: { fact: "baseRef", operator: "equals", value: "main", caseSensitive: false },
      })
      assert.strictEqual((yield* configuration.view(repositoryId)).configuredRevision, 0)

      // Binding an unpublished policy is rejected.
      const unpublished = yield* Effect.flip(
        rules.create(
          repositoryId,
          {
            labelId: bug,
            policyId: created.policy.policyId,
            onMatch: "ensure-present",
            onNoMatch: "ensure-absent",
            group: null,
            priority: 0,
            enabled: true,
          },
          actor,
        ),
      )
      assert.strictEqual(unpublished._tag, "RuleInvalid")

      const published = yield* policies.publish(repositoryId, created.policy.policyId, 1, actor)
      assert.strictEqual(published.published?.revision, 1)
      assert.deepStrictEqual(published.published?.manifest.tracks, ["pull_requests"])
      assert.isFalse(published.draftDiffers)
      assert.deepStrictEqual(published.publishedSource, published.draft)
      // Publishing with no rules bound still advances, so the fence is monotonic.
      assert.strictEqual((yield* configuration.view(repositoryId)).configuredRevision, 1)

      // Publishing the same program again reuses the version.
      const again = yield* policies.publish(
        repositoryId,
        created.policy.policyId,
        published.policy.version,
        actor,
      )
      assert.strictEqual(again.published?.versionId, published.published?.versionId)

      const rule = yield* rules.create(
        repositoryId,
        {
          labelId: bug,
          policyId: created.policy.policyId,
          onMatch: "ensure-present",
          onNoMatch: "ensure-absent",
          group: null,
          priority: 0,
          enabled: true,
        },
        actor,
      )
      const afterRule = yield* configuration.view(repositoryId)
      assert.strictEqual(afterRule.configuredRevision, 3)
      assert.deepStrictEqual(afterRule.pendingTracks, [])
      // Publication is immediately available without requesting synchronization.
      assert.strictEqual(afterRule.activeRevision, 3)

      const snapshot = Option.getOrThrow(
        yield* configuration.load(repositoryId, LabelingRevision.make(3)),
      )
      assert.deepStrictEqual(
        snapshot.rules.map((entry) => [entry.id, entry.policyVersionId]),
        [[rule.id, published.published?.versionId]],
      )
      assert.strictEqual(snapshot.versions.length, 1)

      yield* verifyTrack("pull_requests")
      assert.isTrue(Option.isNone(yield* activation.promote(repositoryId)))
      assert.strictEqual((yield* configuration.view(repositoryId)).activeRevision, 3)

      // Every change is audited with the Access subject.
      const audit = yield* rules.audit(repositoryId)
      assert.deepStrictEqual(
        audit.map((entry) => [entry.subject._tag, entry.operation]).reverse(),
        [
          ["Policy", "create"],
          ["Policy", "publish"],
          ["Policy", "publish"],
          ["Rule", "create"],
        ],
      )
      assert.strictEqual(audit[0]?.actor.subject, "user-1")
    }),
  )

  it.effect("rejects bad programs, resolves references by name, and guards deletion", () =>
    Effect.gen(function* () {
      const policies = yield* Policies

      const invalid = yield* policies.validate(
        repositoryId,
        { target: "issue", matchesWhen: { fact: "draft", operator: "is", value: true } },
        Option.none(),
      )
      assert.strictEqual(invalid._tag, "Invalid")
      assert.include(invalid._tag === "Invalid" ? invalid.message : "", "does not exist for issue")

      const unknown = yield* policies.validate(
        repositoryId,
        { target: "pull_request", matchesWhen: { policy: "nope" } },
        Option.none(),
      )
      assert.strictEqual(unknown._tag, "Invalid")

      const referencing = yield* policies.create(
        repositoryId,
        {
          name: "Ready",
          description: "",
          source: {
            target: "pull_request",
            matchesWhen: {
              all: [{ policy: "base is main" }, { fact: "draft", operator: "is", value: false }],
            },
          },
        },
        actor,
      )
      assert.deepStrictEqual(
        "matchesWhen" in referencing.draft ? referencing.draft.matchesWhen : null,
        {
          all: [{ policy: "Base is main" }, { fact: "draft", operator: "is", value: false }],
        },
      )
      const publishedReferencing = yield* policies.publish(
        repositoryId,
        referencing.policy.policyId,
        1,
        actor,
      )
      const base = (yield* policies.list(repositoryId)).find(
        (policy) => policy.name === "Base is main",
      )!
      assert.deepStrictEqual(publishedReferencing.published?.manifest.references, [base.policyId])

      const duplicate = yield* Effect.flip(
        policies.create(repositoryId, { name: "ready", description: "", source: baseMain }, actor),
      )
      assert.strictEqual(duplicate._tag, "PolicyNameTaken")

      // Bound by a rule and referenced by a program: not deletable.
      const inUse = yield* Effect.flip(
        policies.remove(repositoryId, base.policyId, base.version, actor),
      )
      assert.strictEqual(inUse._tag, "PolicyInUse")
      if (inUse._tag === "PolicyInUse") {
        assert.strictEqual(inUse.rules, 1)
        assert.strictEqual(inUse.references, 1)
      }

      const stale = yield* Effect.flip(
        policies.save(repositoryId, base.policyId, { version: 1, description: "x" }, actor),
      )
      assert.strictEqual(stale._tag, "PolicyConflict")
    }),
  )

  it.effect("tests drafts, policies, and the configuration against open pull requests", () =>
    Effect.gen(function* () {
      const test = yield* LabelingTest
      const policies = yield* Policies
      const base = (yield* policies.list(repositoryId)).find(
        (policy) => policy.name === "Base is main",
      )!

      const items = yield* test.items(repositoryId)
      assert.deepStrictEqual(
        items.map((item) => item.number),
        [6, 5],
      )
      assert.isTrue(items.every((item) => item.evaluation === null && item.plan === null))
      const draft = yield* test.run(repositoryId, {
        subject: {
          _tag: "Draft",
          source: {
            target: "pull_request",
            matchesWhen: { fact: "baseRef", operator: "equals", value: "develop" },
          },
        },
        numbers: [],
      })
      assert.strictEqual(draft._tag, "Evaluated")
      if (draft._tag !== "Evaluated") return
      assert.deepStrictEqual(
        draft.entities.map((entity) => [entity.number, entity.evaluation?.outcome]),
        [
          [6, "match"],
          [5, "no-match"],
        ],
      )

      const policy = yield* test.run(repositoryId, {
        subject: { _tag: "Policy", policyId: base.policyId },
        numbers: [5],
      })
      assert.strictEqual(
        policy._tag === "Evaluated" ? policy.entities[0]?.evaluation?.outcome : policy._tag,
        "match",
      )

      const configured = yield* test.run(repositoryId, {
        subject: { _tag: "Configuration" },
        numbers: [],
      })
      assert.strictEqual(configured._tag, "Evaluated")
      if (configured._tag !== "Evaluated") return
      assert.deepStrictEqual(
        configured.entities.map((entity) => [
          entity.number,
          entity.plan?.actions.map((action) => action.action),
        ]),
        [
          [6, []],
          [5, ["add"]],
        ],
      )
      const rejected = yield* test.run(repositoryId, {
        subject: {
          _tag: "Draft",
          source: { target: "pull_request", matchesWhen: { policy: "missing" } },
        },
        numbers: [],
      })
      assert.strictEqual(rejected._tag, "Rejected")

      // Collection facts are unknown until a refresh fetched them, then evaluate.
      const changeset: ProgramSource = {
        target: "pull_request",
        matchesWhen: {
          some: "changedFiles",
          where: { fact: "path", operator: "matchesGlob", value: ".changeset/*.md" },
        },
      }
      const unknown = yield* test.run(repositoryId, {
        subject: { _tag: "Draft", source: changeset },
        numbers: [5],
      })
      assert.strictEqual(
        unknown._tag === "Evaluated" ? unknown.entities[0]?.evaluation?.outcome : unknown._tag,
        "unknown",
      )
      const readModel = yield* GitHubReadModel
      yield* readModel.applyPullRequestCollections({
        repositoryId,
        number: 5,
        collections: {
          files: [
            { path: ".changeset/brave-owls.md", status: "added" },
            { path: "src/a.ts", status: "modified" },
          ],
          filesComplete: true,
          checksComplete: true,
          reviewsComplete: true,
          checks: [{ name: "ci", state: "success" }],
          reviews: [{ reviewer: "octocat", state: "APPROVED" }],
        },
      })
      const known = yield* test.run(repositoryId, {
        subject: { _tag: "Draft", source: changeset },
        numbers: [5],
      })
      assert.strictEqual(
        known._tag === "Evaluated" ? known.entities[0]?.evaluation?.outcome : known._tag,
        "match",
      )
      const reviewed = yield* test.run(repositoryId, {
        subject: {
          _tag: "Draft",
          source: {
            target: "pull_request",
            matchesWhen: {
              none: "reviews",
              where: { fact: "state", operator: "equals", value: "CHANGES_REQUESTED" },
            },
          },
        },
        numbers: [5],
      })
      assert.strictEqual(
        reviewed._tag === "Evaluated" ? reviewed.entities[0]?.evaluation?.outcome : reviewed._tag,
        "match",
      )
    }),
  )
  it.effect("allows only one concurrent save and keeps its metadata and draft together", () =>
    Effect.gen(function* () {
      const policies = yield* Policies
      const created = yield* policies.create(
        repositoryId,
        { name: "Concurrent", description: "", source: baseMain },
        actor,
      )
      const outcomes = yield* Effect.forEach(
        ["main", "develop"],
        (value) =>
          policies
            .save(
              repositoryId,
              created.policy.policyId,
              {
                version: 1,
                description: value,
                source: {
                  target: "pull_request",
                  matchesWhen: { fact: "baseRef", operator: "equals", value },
                },
              },
              actor,
            )
            .pipe(Effect.match({ onFailure: (error) => error._tag, onSuccess: () => "Saved" })),
        { concurrency: "unbounded" },
      )
      assert.deepStrictEqual([...outcomes].sort(), ["PolicyConflict", "Saved"])
      const current = yield* policies.get(repositoryId, created.policy.policyId)
      assert.strictEqual(current.policy.version, 2)
      assert.deepStrictEqual(current.draft, {
        target: "pull_request",
        matchesWhen: {
          fact: "baseRef",
          operator: "equals",
          value: current.policy.description,
          caseSensitive: false,
        },
      })
    }),
  )

  it.effect("rejects publishing a dependency that breaks an existing consumer", () =>
    Effect.gen(function* () {
      const policies = yield* Policies
      const base = yield* policies.create(
        repositoryId,
        { name: "Shared dependency", description: "", source: baseMain },
        actor,
      )
      const published = yield* policies.publish(repositoryId, base.policy.policyId, 1, actor)
      const consumer = yield* policies.create(
        repositoryId,
        {
          name: "Consumer",
          description: "",
          source: { target: "pull_request", matchesWhen: { policy: "Shared dependency" } },
        },
        actor,
      )
      yield* policies.publish(repositoryId, consumer.policy.policyId, 1, actor)
      const edited = yield* policies.save(
        repositoryId,
        base.policy.policyId,
        {
          version: published.policy.version,
          source: {
            target: "issue",
            matchesWhen: { fact: "title", operator: "contains", value: "bug" },
          },
        },
        actor,
      )
      const rejected = yield* Effect.flip(
        policies.publish(repositoryId, base.policy.policyId, edited.policy.version, actor),
      )
      assert.strictEqual(rejected._tag, "PolicyInvalid")
      if (rejected._tag === "PolicyInvalid") assert.include(rejected.message, "Consumer")
      assert.strictEqual(
        (yield* policies.get(repositoryId, base.policy.policyId)).published?.versionId,
        published.published?.versionId,
      )
      const selfReference = yield* (yield* LabelingTest).run(repositoryId, {
        subject: {
          _tag: "Draft",
          policyId: base.policy.policyId,
          source: { target: "pull_request", matchesWhen: { policy: "Shared dependency" } },
        },
        numbers: [],
      })
      assert.strictEqual(selfReference._tag, "Rejected")
    }),
  )

  it.effect("refreshes required tracks when a referenced policy stops using a fact", () =>
    Effect.gen(function* () {
      const policies = yield* Policies
      const rules = yield* LabelingRules
      const configuration = yield* LabelingConfiguration
      const dependency = yield* policies.create(
        repositoryId,
        {
          name: "Label dependent",
          description: "",
          source: {
            target: "pull_request",
            matchesWhen: { fact: "labels", operator: "has", value: bug },
          },
        },
        actor,
      )
      const published = yield* policies.publish(repositoryId, dependency.policy.policyId, 1, actor)
      const consumer = yield* policies.create(
        repositoryId,
        {
          name: "Label consumer",
          description: "",
          source: { target: "pull_request", matchesWhen: { policy: "Label dependent" } },
        },
        actor,
      )
      yield* policies.publish(repositoryId, consumer.policy.policyId, 1, actor)
      yield* rules.create(
        repositoryId,
        {
          labelId: bug,
          policyId: consumer.policy.policyId,
          onMatch: "ensure-present",
          onNoMatch: "no-action",
          group: null,
          priority: 0,
          enabled: true,
        },
        actor,
      )
      const before = yield* configuration.view(repositoryId)
      const beforeSnapshot = Option.getOrThrow(
        yield* configuration.load(repositoryId, before.configuredRevision),
      )
      assert.include(beforeSnapshot.requiredTracks, "labels")
      const edited = yield* policies.save(
        repositoryId,
        dependency.policy.policyId,
        { version: published.policy.version, source: baseMain },
        actor,
      )
      yield* policies.publish(
        repositoryId,
        dependency.policy.policyId,
        edited.policy.version,
        actor,
      )
      const after = yield* configuration.view(repositoryId)
      const snapshot = Option.getOrThrow(
        yield* configuration.load(repositoryId, after.configuredRevision),
      )
      assert.notInclude(snapshot.requiredTracks, "labels")
      assert.include(snapshot.requiredTracks, "pull_requests")
    }),
  )
  it.effect(
    "preserves references through renames and reports historical references on deletion",
    () =>
      Effect.gen(function* () {
        const policies = yield* Policies
        const base = yield* policies.create(
          repositoryId,
          { name: "Original name", description: "", source: baseMain },
          actor,
        )
        const published = yield* policies.publish(repositoryId, base.policy.policyId, 1, actor)
        const consumer = yield* policies.create(
          repositoryId,
          {
            name: "Historical consumer",
            description: "",
            source: { target: "pull_request", matchesWhen: { policy: "Original name" } },
          },
          actor,
        )
        const publishedConsumer = yield* policies.publish(
          repositoryId,
          consumer.policy.policyId,
          1,
          actor,
        )
        const renamed = yield* policies.save(
          repositoryId,
          base.policy.policyId,
          { version: published.policy.version, name: "Renamed dependency" },
          actor,
        )
        assert.deepStrictEqual(
          (yield* policies.get(repositoryId, consumer.policy.policyId)).draft,
          { target: "pull_request", matchesWhen: { policy: "Renamed dependency" } },
        )
        const edited = yield* policies.save(
          repositoryId,
          consumer.policy.policyId,
          { version: publishedConsumer.policy.version, source: baseMain },
          actor,
        )
        yield* policies.publish(
          repositoryId,
          consumer.policy.policyId,
          edited.policy.version,
          actor,
        )
        const blocked = yield* Effect.flip(
          policies.remove(repositoryId, base.policy.policyId, renamed.policy.version, actor),
        )
        assert.strictEqual(blocked._tag, "PolicyInUse")
        if (blocked._tag === "PolicyInUse") assert.strictEqual(blocked.references, 1)
      }),
  )

  it.effect("rejects concurrent rule edits instead of reporting both as saved", () =>
    Effect.gen(function* () {
      const policies = yield* Policies
      const rules = yield* LabelingRules
      const base = (yield* policies.list(repositoryId)).find(
        (policy) => policy.name === "Base is main",
      )!
      const created = yield* rules.create(
        repositoryId,
        {
          labelId: bug,
          policyId: base.policyId,
          onMatch: "ensure-present",
          onNoMatch: "no-action",
          group: null,
          priority: 0,
          enabled: true,
        },
        actor,
      )
      const outcomes = yield* Effect.forEach(
        [1, 2],
        (priority) =>
          rules
            .patch(repositoryId, created.id, { version: created.version, priority }, actor)
            .pipe(Effect.match({ onFailure: (error) => error._tag, onSuccess: () => "Saved" })),
        { concurrency: "unbounded" },
      )
      assert.deepStrictEqual([...outcomes].sort(), ["RuleConflict", "Saved"])
    }),
  )
  it.effect("allows classifier conversion without changing configured result actions", () =>
    Effect.gen(function* () {
      const policies = yield* Policies
      const rules = yield* LabelingRules
      const created = yield* policies.create(
        repositoryId,
        { name: "Deterministic bound policy", description: "", source: baseMain },
        actor,
      )
      const published = yield* policies.publish(repositoryId, created.policy.policyId, 1, actor)
      const rule = yield* rules.create(
        repositoryId,
        {
          labelId: bug,
          policyId: created.policy.policyId,
          onMatch: "ensure-present",
          onNoMatch: "ensure-absent",
          group: null,
          priority: 0,
          enabled: true,
        },
        actor,
      )
      const source: ProgramSource = {
        target: "pull_request",
        classify: {
          prompt: "Is {{fact:title}} a bug?",
          evidence: ["title"],
          minimumConfidence: 0.9,
        },
      }
      const validation = yield* policies.validate(
        repositoryId,
        source,
        Option.some(created.policy.policyId),
      )
      assert.strictEqual(validation._tag, "Valid")
      const edited = yield* policies.save(
        repositoryId,
        created.policy.policyId,
        { version: published.policy.version, source },
        actor,
      )
      const converted = yield* policies.publish(
        repositoryId,
        created.policy.policyId,
        edited.policy.version,
        actor,
      )
      assert.strictEqual(converted.published?.program.evaluator._tag, "Classifier")
      assert.strictEqual(
        (yield* rules.list(repositoryId)).find((entry) => entry.id === rule.id)?.onNoMatch,
        "ensure-absent",
      )
    }),
  )
  it.effect("retains an unbound policy's versions when configuration history uses them", () =>
    Effect.gen(function* () {
      const policies = yield* Policies
      const rules = yield* LabelingRules
      const configuration = yield* LabelingConfiguration
      const created = yield* policies.create(
        repositoryId,
        { name: "Retained configuration policy", description: "", source: baseMain },
        actor,
      )
      const published = yield* policies.publish(repositoryId, created.policy.policyId, 1, actor)
      const rule = yield* rules.create(
        repositoryId,
        {
          labelId: bug,
          policyId: created.policy.policyId,
          onMatch: "ensure-present",
          onNoMatch: "no-action",
          group: null,
          priority: 0,
          enabled: true,
        },
        actor,
      )
      const revision = (yield* configuration.view(repositoryId)).configuredRevision
      const before = Option.getOrThrow(yield* configuration.load(repositoryId, revision))
      assert.isTrue(before.versions.some((version) => version.policyId === created.policy.policyId))
      yield* rules.remove(repositoryId, rule.id, rule.version, actor)
      const currentRevision = (yield* configuration.view(repositoryId)).configuredRevision
      const current = Option.getOrThrow(yield* configuration.load(repositoryId, currentRevision))
      assert.isFalse(
        current.versions.some((version) => version.policyId === created.policy.policyId),
      )
      const blocked = yield* Effect.flip(
        policies.remove(repositoryId, created.policy.policyId, published.policy.version, actor),
      )
      assert.strictEqual(blocked._tag, "PolicyInvalid")
      if (blocked._tag === "PolicyInvalid") assert.include(blocked.message, "configuration history")
      assert.deepStrictEqual(
        Option.getOrThrow(yield* configuration.load(repositoryId, revision)),
        before,
      )
      assert.strictEqual(
        (yield* policies.get(repositoryId, created.policy.policyId)).published?.versionId,
        published.published?.versionId,
      )
    }),
  )
  it.effect("reports saved program differences in the policy library", () =>
    Effect.gen(function* () {
      yield* seed
      const policies = yield* Policies
      const configuration = yield* LabelingConfiguration
      let detail = yield* policies.create(
        repositoryId,
        { name: "Status example", description: "", source: baseMain },
        actor,
      )
      const id = detail.policy.policyId
      const differs = Effect.gen(function* () {
        return (yield* configuration.view(repositoryId)).policies.find(
          (policy) => policy.policyId === id,
        )?.draftDiffers
      })
      assert.isTrue(yield* differs)
      detail = yield* policies.publish(repositoryId, id, detail.policy.version, actor)
      assert.isFalse(yield* differs)
      assert.strictEqual(
        (yield* policies.list(repositoryId)).find((policy) => policy.policyId === id)
          ?.publishedEvaluator,
        "Conditions",
      )
      detail = yield* policies.save(
        repositoryId,
        id,
        { version: detail.policy.version, description: "Only metadata changed" },
        actor,
      )
      assert.isFalse(yield* differs)
      detail = yield* policies.save(
        repositoryId,
        id,
        {
          version: detail.policy.version,
          source: {
            target: "pull_request",
            matchesWhen: { fact: "baseRef", operator: "equals", value: "next" },
          },
        },
        actor,
      )
      assert.isTrue(yield* differs)
      assert.isTrue(
        (yield* policies.list(repositoryId)).find((policy) => policy.policyId === id)?.draftDiffers,
      )
      yield* policies.save(
        repositoryId,
        id,
        { version: detail.policy.version, source: baseMain },
        actor,
      )
      assert.isFalse(yield* differs)
    }),
  )
  it.effect("identifies published classifiers for reference completion", () =>
    Effect.gen(function* () {
      const policies = yield* Policies
      const draft = yield* policies.create(
        repositoryId,
        {
          name: "Snippet classifier",
          description: "",
          source: {
            target: "issue",
            classify: {
              prompt: "Does this describe a bug?",
              evidence: ["title"],
              minimumConfidence: 0.8,
            },
          },
        },
        actor,
      )
      assert.isUndefined(draft.policy.publishedEvaluator)
      yield* policies.publish(repositoryId, draft.policy.policyId, draft.policy.version, actor)
      assert.strictEqual(
        (yield* policies.list(repositoryId)).find(
          (policy) => policy.policyId === draft.policy.policyId,
        )?.publishedEvaluator,
        "Classifier",
      )
    }),
  )
})
