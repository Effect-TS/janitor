import { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { LabelingRevision, PolicyVersionId } from "@janitor/domain/Labeling/Policy/Configuration"
import { evaluate, type Resolver } from "@janitor/domain/Labeling/Policy/Evaluate"
import { type FactSnapshot, snapshotFacts } from "@janitor/domain/Labeling/Policy/Facts"
import { plan, type RuleBinding } from "@janitor/domain/Labeling/Policy/Plan"
import type { Outcome, Program } from "@janitor/domain/Labeling/Policy/Program"
import { programFromSource, UnknownPolicyName } from "@janitor/domain/Labeling/Policy/Program"
import {
  MAX_TEST_ENTITIES,
  type TestEntity,
  type TestRequest,
  type TestResponse,
} from "@janitor/domain/Labeling/Policy/Test"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { type EntityView, GitHubReadModel } from "../GitHub/ReadModel.ts"
import { describeError } from "../SqlErrors.ts"
import {
  LabelingConfiguration,
  type LabelingConfigurationError,
  type RepositoryNotFound,
} from "./Configuration.ts"
import { classifyOrUnknown } from "./Classifier.ts"
import { Policies } from "./Policies.ts"

export class LabelingTestError extends Data.TaggedError("LabelingTestError")<{
  readonly operation: string
  readonly message: string
}> {}

const PointerRow = Schema.Struct({
  configured_revision: Schema.FiniteFromString.pipe(Schema.decodeTo(LabelingRevision)),
})

export const entityFacts = (view: EntityView): FactSnapshot => {
  const snapshot = snapshotFacts({
    kind: view.entity.kind,
    title: view.entity.title,
    body: view.entity.body,
    authorLogin: view.entity.authorLogin,
    state: view.entity.state,
    labels: view.labels.map((label) => label.labelId),
    pullRequest: Option.map(view.pullRequest, (pr) => ({
      baseRef: pr.baseRef,
      draft: pr.draft,
      headSha: pr.headSha,
    })).pipe(Option.getOrNull),
    ...Option.match(view.collections, {
      onNone: () => ({}),
      onSome: (collections) => ({ collections }),
    }),
  })

  if (Option.isSome(view.collections)) {
    const facts = { ...snapshot.facts }
    const collections = view.collections.value
    if (!collections.filesComplete) delete facts.changedFiles
    if (!collections.checksComplete) delete facts.checks
    if (!collections.reviewsComplete) delete facts.reviews
    return {
      ...snapshot,
      facts,
      unavailableReasons: !collections.filesComplete
        ? {
            changedFiles:
              collections.filesIncompleteReason ??
              `Changed-file listing is incomplete (${collections.files.length} files available)`,
          }
        : {},
    }
  }
  return snapshot
}

/**
 * The test bench (plan: "LabelingTest"). Evaluates a draft, a published
 * policy, or the configured revision against open entities from the read
 * model. Same evaluator as reconciliation, no mutation, no GitHub read.
 */
export class LabelingTest extends Context.Service<
  LabelingTest,
  {
    readonly items: (
      repositoryId: GitHubRepositoryDatabaseId,
    ) => Effect.Effect<
      ReadonlyArray<TestEntity>,
      RepositoryNotFound | LabelingConfigurationError | LabelingTestError
    >
    readonly run: (
      repositoryId: GitHubRepositoryDatabaseId,
      request: TestRequest,
    ) => Effect.Effect<
      TestResponse,
      RepositoryNotFound | LabelingConfigurationError | LabelingTestError
    >
  }
>()("@janitor/cluster/Labeling/Test/LabelingTest", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const readModel = yield* GitHubReadModel
    const configuration = yield* LabelingConfiguration
    const policies = yield* Policies
    const decodePointers = Schema.decodeUnknownEffect(Schema.Array(PointerRow))

    const wrap =
      (operation: string) =>
      <A, R>(effect: Effect.Effect<A, { readonly message: string }, R>) =>
        Effect.mapError(
          effect,
          (error) => new LabelingTestError({ operation, message: describeError(error) }),
        )

    const entities = (repositoryId: GitHubRepositoryDatabaseId, numbers: ReadonlyArray<number>) =>
      numbers.length === 0
        ? readModel.listOpenEntities(repositoryId, MAX_TEST_ENTITIES)
        : Effect.forEach(numbers, (number) => readModel.getEntity(repositoryId, number)).pipe(
            Effect.map((found) =>
              found.flatMap((entity) => (Option.isSome(entity) ? [entity.value] : [])),
            ),
          )

    const describe = (
      view: EntityView,
      evaluation: TestEntity["evaluation"],
      planned: TestEntity["plan"],
    ): TestEntity => ({
      number: view.entity.number,
      kind: view.entity.kind,
      title: view.entity.title,
      authorLogin: view.entity.authorLogin,
      baseRef: Option.map(view.pullRequest, (pr) => pr.baseRef).pipe(Option.getOrNull),
      draft: Option.map(view.pullRequest, (pr) => pr.draft).pipe(Option.getOrNull),
      labels: view.labels.map((label) => label.labelId),
      evaluation,
      plan: planned,
    })

    const run = Effect.fn("LabelingTest.run")(function* (
      repositoryId: GitHubRepositoryDatabaseId,
      request: TestRequest,
    ) {
      yield* configuration.requireRepository(repositoryId)
      const views = yield* entities(repositoryId, request.numbers).pipe(wrap("entities"))

      switch (request.subject._tag) {
        case "Draft":
        case "Policy": {
          const resolve = yield* policies.resolver(repositoryId).pipe(wrap("resolver"))
          let program: Program
          if (request.subject._tag === "Draft") {
            const names = yield* policies.names(repositoryId).pipe(wrap("names"))
            const decoded = programFromSource(request.subject.source, names)
            if (decoded instanceof UnknownPolicyName) {
              return {
                _tag: "Rejected",
                message: `Policy '${decoded.name}' does not exist`,
              } as const
            }
            const validation = yield* policies
              .validate(
                repositoryId,
                request.subject.source,
                Option.fromUndefinedOr(request.subject.policyId),
              )
              .pipe(wrap("validate"))
            if (validation._tag === "Invalid") {
              return { _tag: "Rejected", message: validation.message } as const
            }
            program = decoded
          } else {
            const version = resolve(request.subject.policyId)
            if (version === undefined) {
              return { _tag: "Rejected", message: "The policy is not published" } as const
            }
            program = version.program
          }
          // Classifier caches also include the prompt, evidence, provider, and confidence threshold.
          const versionId =
            request.subject._tag === "Policy"
              ? (resolve(request.subject.policyId)?.versionId ?? "draft")
              : "draft"
          const entities = yield* Effect.forEach(views, (view) =>
            Effect.map(
              program.evaluator._tag === "Classifier"
                ? classifyOrUnknown({
                    inspectInput: true,
                    repositoryId,
                    number: view.entity.number,
                    policyVersionId: PolicyVersionId.make(versionId),
                    program,
                    evaluator: program.evaluator,
                    snapshot: entityFacts(view),
                    resolve,
                  })
                : Effect.succeed(evaluate({ program, snapshot: entityFacts(view), resolve })),
              (evaluation) => describe(view, evaluation, null),
            ),
          )
          return { _tag: "Evaluated", entities } as const
        }
        case "Configuration": {
          const pointer = yield* sql`
            SELECT configured_revision::text FROM labeling_repository_rules WHERE repository_id = ${repositoryId}
          `.pipe(Effect.flatMap(decodePointers), wrap("pointer"))
          const revision = pointer[0]?.configured_revision
          const snapshot =
            revision === undefined
              ? Option.none()
              : yield* configuration.load(repositoryId, revision).pipe(wrap("load"))
          if (Option.isNone(snapshot)) {
            return { _tag: "Rejected", message: "Nothing is configured yet" } as const
          }
          const versions = new Map(
            snapshot.value.versions.map((version) => [version.versionId, version]),
          )
          const byPolicy = new Map(
            snapshot.value.versions.map((version) => [version.policyId, version]),
          )
          const resolve: Resolver = (policyId) => byPolicy.get(policyId)
          const entities = yield* Effect.forEach(views, (view) =>
            Effect.gen(function* () {
              const facts = entityFacts(view)
              const outcomes = new Map<RuleBinding["id"], Outcome>()
              for (const rule of snapshot.value.rules) {
                const version = versions.get(rule.policyVersionId)
                const outcome: Outcome =
                  version === undefined
                    ? "unknown"
                    : version.program.evaluator._tag === "Classifier"
                      ? (yield* classifyOrUnknown({
                          inspectInput: true,
                          repositoryId,
                          number: view.entity.number,
                          policyVersionId: version.versionId,
                          program: version.program,
                          evaluator: version.program.evaluator,
                          snapshot: facts,
                          resolve,
                        })).outcome
                      : evaluate({ program: version.program, snapshot: facts, resolve }).outcome
                outcomes.set(rule.id, outcome)
              }
              return describe(
                view,
                null,
                plan({
                  rules: snapshot.value.rules,
                  outcomes,
                  currentLabels: new Set(
                    facts.facts.labels?._tag === "LabelSet" ? facts.facts.labels.value : [],
                  ),
                }),
              )
            }),
          )
          return { _tag: "Evaluated", entities } as const
        }
      }
    })

    const items = Effect.fn("LabelingTest.items")(function* (
      repositoryId: GitHubRepositoryDatabaseId,
    ) {
      yield* configuration.requireRepository(repositoryId)
      const views = yield* entities(repositoryId, []).pipe(wrap("items"))
      return views.map((view) => describe(view, null, null))
    })
    return { run, items }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
