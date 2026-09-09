import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { GitHubIssueApi } from "@janitor/domain/GitHub/Api"
import {
  GitHubAccountDatabaseId,
  GitHubCommitSha,
  GitHubInstallationId,
  GitHubLabelDatabaseId,
  GitHubLabelNodeId,
  GitHubPullRequestDatabaseId,
  GitHubPullRequestNodeId,
  GitHubRepositoryDatabaseId,
} from "@janitor/domain/GitHub/Id"
import { GitHubWebhookJournalSequence } from "@janitor/domain/GitHub/WebhookJournal"
import type { ProgramSource } from "@janitor/domain/Labeling/Policy/Program"
import { GitHubReadModel } from "../../src/GitHub/ReadModel.ts"
import { RulesetActivation } from "../../src/Labeling/Activation.ts"
import { LabelingConfiguration } from "../../src/Labeling/Configuration.ts"
import { Policies } from "../../src/Labeling/Policies.ts"
import { SnapshotHandoff } from "../../src/Labeling/SnapshotHandoff.ts"
import { LabelingRules } from "../../src/Labeling/Rules.ts"
import { LabelingTest } from "../../src/Labeling/Test.ts"
import { SyncTargets } from "../../src/SyncTargets.ts"
import { WorkflowOutbox } from "../../src/WorkflowOutbox.ts"
import { MigratedPostgresLayer } from "../support/Postgres.ts"

/** Shared fixtures for the labeling suites: services, a repository with two labels, and two open pull requests. */
export const LabelingLayer = Layer.mergeAll(LabelingRules.layer, LabelingTest.layer).pipe(
  Layer.provideMerge(Policies.layer),
  Layer.provideMerge(LabelingConfiguration.layer),
  Layer.provideMerge(SnapshotHandoff.layer),
  Layer.provideMerge(
    Layer.mergeAll(SyncTargets.layer, GitHubReadModel.layer, RulesetActivation.layer),
  ),
  Layer.provideMerge(WorkflowOutbox.layer),
)

export const Services = LabelingLayer.pipe(Layer.provideMerge(MigratedPostgresLayer))

export const installationId = GitHubInstallationId.make("77")
export const repositoryId = GitHubRepositoryDatabaseId.make("701")
export const bug = GitHubLabelDatabaseId.make("11")
export const feature = GitHubLabelDatabaseId.make("12")
export const seq = GitHubWebhookJournalSequence.make("1")
export const actor = { issuer: "https://team.cloudflareaccess.test", subject: "user-1" }

export const baseMain: ProgramSource = {
  target: "pull_request",
  matchesWhen: { fact: "baseRef", operator: "equals", value: "main" },
}

export const seed = Effect.gen(function* () {
  const readModel = yield* GitHubReadModel
  yield* readModel.applyInstallation({
    installation: {
      id: installationId,
      account: { id: GitHubAccountDatabaseId.make("1"), login: "effect", type: "Organization" },
      repositorySelection: "all",
      htmlUrl: "https://github.com/settings/installations/77",
      suspendedAt: null,
    },
    status: "active",
    sequence: seq,
  })
  yield* readModel.applyRepositories({
    installationId,
    repositories: [
      { id: repositoryId, fullName: { owner: "effect", repo: "one" }, isPrivate: false },
    ],
    sequence: seq,
  })
  // Mutation is fenced on the repository being enabled; the read model
  // starts repositories paused.
  const sql = yield* SqlClient.SqlClient
  yield* sql`UPDATE github_repository SET enabled = TRUE, connected = TRUE WHERE repository_id = ${repositoryId}`
  yield* readModel.applyLabelCatalog({
    repositoryId,
    labels: [
      { id: bug, nodeId: GitHubLabelNodeId.make("LA_bug"), name: "bug" },
      { id: feature, nodeId: GitHubLabelNodeId.make("LA_feature"), name: "feature" },
    ],
    sequence: seq,
  })
})

/** Two open pull requests: #5 against main, #6 against develop. */
export const seedPullRequests = Effect.gen(function* () {
  const readModel = yield* GitHubReadModel
  for (const [number, base] of [
    [5, "main"],
    [6, "develop"],
  ] as const) {
    const issue = yield* Schema.decodeUnknownEffect(GitHubIssueApi)({
      id: 1000 + number,
      node_id: `I_${number}`,
      number,
      title: `Change ${number}`,
      body: null,
      state: "open",
      user: { id: 9, login: "octocat" },
      labels: [],
      updated_at: `2026-09-03T14:0${number}:00Z`,
      pull_request: { url: "https://api.github.com/x" },
    })
    yield* readModel.applyIssue({ repositoryId, sequence: seq, issue })
    yield* readModel.applyPullRequestDetails({
      repositoryId,
      sequence: seq,
      pullRequest: {
        id: GitHubPullRequestDatabaseId.make(String(2000 + number)),
        nodeId: GitHubPullRequestNodeId.make(`PR_${number}`),
        number,
        state: "open",
        draft: false,
        mergedAt: null,
        updatedAt: DateTime.makeUnsafe(`2026-09-03T14:0${number}:00.000Z`),
        head: { sha: GitHubCommitSha.make("a".repeat(40)) },
        base: { ref: base },
      },
    })
  }
})

export const verifyTrack = (track: "labels" | "entities" | "pull_requests") =>
  Effect.gen(function* () {
    const targets = yield* SyncTargets
    const scope = { _tag: "RepositoryTrack", repositoryId, track } as const
    const existing = yield* targets.get(scope)
    if (Option.isNone(existing)) yield* targets.invalidate({ scope, sequence: Option.some(seq) })
    const record = Option.getOrThrow(yield* targets.get(scope))
    yield* targets.begin(scope, record.requestedGeneration)
    yield* targets.complete({
      scope,
      generation: record.requestedGeneration,
      outcome: { _tag: "Verified", watermark: Option.none() },
    })
  })

/** A connected repository whose initial synchronization has completed. */
export const seedReady = seed.pipe(
  Effect.andThen(
    Effect.gen(function* () {
      const targets = yield* SyncTargets
      for (const track of ["labels", "entities", "pull_requests"] as const) {
        yield* targets.invalidate({
          scope: { _tag: "RepositoryTrack", repositoryId, track },
          sequence: Option.none(),
        })
        yield* verifyTrack(track)
      }
    }),
  ),
)
