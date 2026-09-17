import type { GitHubIssueApi } from "@janitor/domain/GitHub/Api"
import { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { LabelingRevision, PolicyVersionId } from "@janitor/domain/Labeling/Policy/Configuration"
import { evaluate } from "@janitor/domain/Labeling/Policy/Evaluate"
import { type FactSnapshot, snapshotFacts } from "@janitor/domain/Labeling/Policy/Facts"
import type { Program } from "@janitor/domain/Labeling/Policy/Program"
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
import { GitHubTransport } from "../GitHub/Transport.ts"
import { describeError } from "../SqlErrors.ts"
import {
  LabelingConfiguration,
  type LabelingConfigurationError,
  type RepositoryNotFound,
} from "./Configuration.ts"
import { classifyAi, ClassifierError, EvaluationRetry } from "./Classifier.ts"
import { evaluateLabeling } from "./Evaluation.ts"
import { fetchIssue, fetchOpenItems, type RepositoryTarget, withBriefWaits } from "./GitHubIssue.ts"
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

/** One item under test with the facts its evaluation reads, and where they came from. */
interface TestItem {
  readonly entity: Omit<TestEntity, "evaluation" | "plan">
  readonly facts: FactSnapshot
}

const fromView = (view: EntityView): TestItem => ({
  entity: {
    number: view.entity.number,
    kind: view.entity.kind,
    title: view.entity.title,
    authorLogin: view.entity.authorLogin,
    baseRef: Option.map(view.pullRequest, (pr) => pr.baseRef).pipe(Option.getOrNull),
    draft: Option.map(view.pullRequest, (pr) => pr.draft).pipe(Option.getOrNull),
    labels: view.labels.map((label) => label.labelId),
    source: "cache",
  },
  facts: entityFacts(view),
})

const fromIssue = (issue: GitHubIssueApi): TestItem => ({
  entity: {
    number: issue.number,
    kind: "issue",
    title: issue.title,
    authorLogin: issue.user?.login ?? "ghost",
    baseRef: null,
    draft: null,
    labels: issue.labels.map((label) => label.id),
    labelNames: Object.fromEntries(issue.labels.map((label) => [label.id, label.name])),
    source: "github",
  },
  facts: snapshotFacts({
    kind: "issue",
    title: issue.title,
    body: issue.body,
    authorLogin: issue.user?.login ?? "ghost",
    state: issue.state,
    labels: issue.labels.map((label) => label.id),
    pullRequest: null,
  }),
})

/**
 * The test bench (plan: "LabelingTest"). Evaluates a draft, a published
 * policy, or the configured revision against open items. Issues are read
 * from GitHub when the test runs (ADR 0006); pull requests still come from
 * the synchronized read model until their own migration. Same evaluator as
 * reconciliation, no mutation.
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
    const transport = yield* GitHubTransport
    const decodePointers = Schema.decodeUnknownEffect(Schema.Array(PointerRow))

    const wrap =
      (operation: string) =>
      <A, R>(effect: Effect.Effect<A, { readonly message: string }, R>) =>
        Effect.mapError(
          effect,
          (error) => new LabelingTestError({ operation, message: describeError(error) }),
        )

    const target = (repositoryId: GitHubRepositoryDatabaseId) =>
      readModel.getRepository(repositoryId).pipe(
        Effect.flatMap((repository) =>
          Option.isNone(repository)
            ? Effect.fail(new LabelingTestError({ operation: "repository", message: "unknown" }))
            : Effect.succeed<RepositoryTarget>({
                installationId: repository.value.installationId,
                owner: repository.value.owner,
                repo: repository.value.repo,
              }),
        ),
        wrap("repository"),
      )

    const github = <A>(
      effect: Effect.Effect<
        A,
        Effect.Error<ReturnType<typeof fetchIssue>>,
        Effect.Services<ReturnType<typeof fetchIssue>>
      >,
    ) =>
      withBriefWaits(effect).pipe(Effect.provideService(GitHubTransport, transport), wrap("github"))

    /** A pull request keeps its cached facts; absent from the cache, it is not previewed yet. */
    const cachedPullRequest = (repositoryId: GitHubRepositoryDatabaseId, number: number) =>
      readModel.getEntity(repositoryId, number).pipe(
        Effect.map((view) =>
          Option.isSome(view) && view.value.entity.kind === "pull_request"
            ? Option.some(fromView(view.value))
            : Option.none<TestItem>(),
        ),
        wrap("entity"),
      )

    const items = Effect.fn("LabelingTest.entities")(function* (
      repositoryId: GitHubRepositoryDatabaseId,
      numbers: ReadonlyArray<number>,
    ) {
      const repository = yield* target(repositoryId)
      if (numbers.length === 0) {
        const open = yield* github(fetchOpenItems(repository, MAX_TEST_ENTITIES))
        return yield* Effect.forEach(open, (issue) =>
          issue.pullRequest === undefined
            ? Effect.succeed(Option.some(fromIssue(issue)))
            : cachedPullRequest(repositoryId, issue.number),
        ).pipe(Effect.map((found) => found.flatMap(Option.toArray)))
      }
      return yield* Effect.forEach(numbers, (number) =>
        Effect.gen(function* () {
          const cached = yield* cachedPullRequest(repositoryId, number)
          if (Option.isSome(cached)) return cached
          const fetched = yield* github(fetchIssue(repository, number, "foreground"))
          if (fetched._tag === "Unavailable" || fetched.issue.state !== "open")
            return Option.none<TestItem>()
          return fetched.issue.pullRequest === undefined
            ? Option.some(fromIssue(fetched.issue))
            : yield* cachedPullRequest(repositoryId, number)
        }),
      ).pipe(Effect.map((found) => found.flatMap(Option.toArray)))
    })

    const describe = (
      item: TestItem,
      evaluation: TestEntity["evaluation"],
      planned: TestEntity["plan"],
    ): TestEntity => ({ ...item.entity, evaluation, plan: planned })

    const run = Effect.fn("LabelingTest.run")(function* (
      repositoryId: GitHubRepositoryDatabaseId,
      request: TestRequest,
    ) {
      yield* configuration.requireRepository(repositoryId)
      const views = yield* items(repositoryId, request.numbers)

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
          const entities = yield* Effect.forEach(views, (item) =>
            Effect.map(
              program.evaluator._tag === "Classifier"
                ? classifyAi({
                    inspectInput: true,
                    repositoryId,
                    number: item.entity.number,
                    policyVersionId: PolicyVersionId.make(versionId),
                    program,
                    evaluator: program.evaluator,
                    snapshot: item.facts,
                    resolve,
                  })
                : Effect.succeed(evaluate({ program, snapshot: item.facts, resolve })),
              (evaluation) => describe(item, evaluation, null),
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
          const isCurrent = sql`
            SELECT configured_revision::text FROM labeling_repository_rules WHERE repository_id = ${repositoryId}
          `.pipe(
            Effect.flatMap(decodePointers),
            Effect.map((rows) => rows[0]?.configured_revision === revision),
            wrap("current configuration"),
          )
          const entities = yield* Effect.forEach(views, (item) =>
            Effect.gen(function* () {
              const facts = item.facts
              const result = yield* evaluateLabeling({
                configuration: snapshot.value,
                number: item.entity.number,
                facts,
                currentLabels: new Set(
                  facts.facts.labels?._tag === "LabelSet" ? facts.facts.labels.value : [],
                ),
                inspectInput: true,
              }).pipe(
                Effect.provideService(EvaluationRetry, {
                  isCurrent: isCurrent.pipe(
                    Effect.mapError(
                      (error) =>
                        new ClassifierError({
                          operation: "current configuration",
                          message: error.message,
                        }),
                    ),
                  ),
                  report: () => Effect.void,
                }),
              )
              return describe(item, null, result.plan)
            }),
          )
          if (!(yield* isCurrent)) {
            return {
              _tag: "Rejected",
              message: "Configuration changed during evaluation. Run the test again.",
            } as const
          }
          return { _tag: "Evaluated", entities } as const
        }
      }
    })

    const list = Effect.fn("LabelingTest.items")(function* (
      repositoryId: GitHubRepositoryDatabaseId,
    ) {
      yield* configuration.requireRepository(repositoryId)
      const views = yield* items(repositoryId, [])
      return views.map((item) => describe(item, null, null))
    })
    return { run, items: list }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
