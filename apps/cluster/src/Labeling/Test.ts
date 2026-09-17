import type { GitHubIssueApi } from "@janitor/domain/GitHub/Api"
import { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { LabelingRevision, PolicyVersionId } from "@janitor/domain/Labeling/Policy/Configuration"
import { evaluate } from "@janitor/domain/Labeling/Policy/Evaluate"
import type { FactSnapshot, FactTrack } from "@janitor/domain/Labeling/Policy/Facts"
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
import { GitHubReadModel } from "../GitHub/ReadModel.ts"
import type { SyncActivityError, SyncRateLimited } from "../GitHub/SyncSupport.ts"
import { GitHubTransport } from "../GitHub/Transport.ts"
import { describeError } from "../SqlErrors.ts"
import {
  LabelingConfiguration,
  type LabelingConfigurationError,
  type RepositoryNotFound,
} from "./Configuration.ts"
import { classifyAi, ClassifierError, EvaluationRetry } from "./Classifier.ts"
import { evaluateLabeling } from "./Evaluation.ts"
import { authorLogin, isOpenPullRequest, itemFacts, itemKind, type ReadItem } from "./Facts.ts"
import {
  briefWaits,
  fetchIssue,
  fetchOpenItems,
  type RepositoryTarget,
  withBriefWaits,
} from "./GitHubIssue.ts"
import { type CollectionTrack, collectionTracks, readPullRequest } from "./GitHubPullRequest.ts"
import { Policies } from "./Policies.ts"

export class LabelingTestError extends Data.TaggedError("LabelingTestError")<{
  readonly operation: string
  readonly message: string
}> {}

const PointerRow = Schema.Struct({
  configured_revision: Schema.FiniteFromString.pipe(Schema.decodeTo(LabelingRevision)),
})

/** One item under test with the facts its evaluation reads. */
interface TestItem {
  readonly entity: Omit<TestEntity, "evaluation" | "plan">
  readonly facts: FactSnapshot
}

const fromItem = (item: ReadItem): TestItem => ({
  entity: {
    number: item.issue.number,
    kind: itemKind(item.issue),
    title: item.issue.title,
    authorLogin: authorLogin(item.issue),
    baseRef: item.pullRequest?.base.ref ?? null,
    draft: item.pullRequest?.draft ?? null,
    labels: item.issue.labels.map((label) => label.id),
    labelNames: Object.fromEntries(item.issue.labels.map((label) => [label.id, label.name])),
    source: "github",
  },
  facts: itemFacts(item),
})

/**
 * The test bench (plan: "LabelingTest"). Evaluates a draft, a published
 * policy, or the configured revision against open items. Every fact is read
 * from GitHub when the test runs (ADR 0006), including the collections the
 * subject needs for a pull request. Same evaluator as automatic labeling,
 * no mutation.
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

    const github = <A, R>(effect: Effect.Effect<A, SyncRateLimited | SyncActivityError, R>) =>
      withBriefWaits(effect).pipe(Effect.provideService(GitHubTransport, transport), wrap("github"))

    /** The open items to test, with the collections the subject reads for pull requests. */
    const items = Effect.fn("LabelingTest.items")(function* (
      repositoryId: GitHubRepositoryDatabaseId,
      numbers: ReadonlyArray<number>,
      tracks: ReadonlyArray<CollectionTrack>,
    ) {
      const repository = yield* target(repositoryId)
      const issues: ReadonlyArray<GitHubIssueApi> =
        numbers.length === 0
          ? yield* github(fetchOpenItems(repository, MAX_TEST_ENTITIES))
          : (yield* Effect.forEach(numbers, (number) =>
              github(fetchIssue(repository, number, "foreground")),
            )).flatMap((fetched) =>
              fetched._tag === "Found" && fetched.issue.state === "open" ? [fetched.issue] : [],
            )
      return yield* Effect.forEach(issues, (issue) =>
        Effect.gen(function* () {
          if (issue.pullRequest === undefined)
            return Option.some(fromItem({ issue, pullRequest: null, collections: {} }))
          const read = yield* readPullRequest(
            "LabelingTest",
            repository,
            issue.number,
            tracks,
            briefWaits,
          ).pipe(Effect.provideService(GitHubTransport, transport), wrap("github"))
          if (read._tag === "Changed")
            return yield* new LabelingTestError({
              operation: "github",
              message: `Pull request #${issue.number} changed while its facts were read. Run the test again.`,
            })
          // Gone since the listing, or closed or merged: not an open item.
          if (read._tag === "Unavailable" || !isOpenPullRequest(read.pullRequest))
            return Option.none<TestItem>()
          return Option.some(
            fromItem({ issue, pullRequest: read.pullRequest, collections: read.collections }),
          )
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

      switch (request.subject._tag) {
        case "Draft":
        case "Policy": {
          const resolve = yield* policies.resolver(repositoryId).pipe(wrap("resolver"))
          let program: Program
          let tracks: ReadonlyArray<FactTrack>
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
            tracks = validation.manifest.tracks
          } else {
            const version = resolve(request.subject.policyId)
            if (version === undefined) {
              return { _tag: "Rejected", message: "The policy is not published" } as const
            }
            program = version.program
            tracks = version.manifest.tracks
          }
          const views = yield* items(repositoryId, request.numbers, collectionTracks(tracks))
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
          const views = yield* items(
            repositoryId,
            request.numbers,
            collectionTracks(snapshot.value.requiredTracks),
          )
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

    const list = Effect.fn("LabelingTest.list")(function* (
      repositoryId: GitHubRepositoryDatabaseId,
    ) {
      yield* configuration.requireRepository(repositoryId)
      const views = yield* items(repositoryId, [], [])
      return views.map((item) => describe(item, null, null))
    })
    return { run, items: list }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
