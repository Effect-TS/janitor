import * as DateTime from "effect/DateTime"
import { assert } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
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
import { GitHubTransport } from "../../src/GitHub/Transport.ts"
import { RepositoryEligibility } from "../../src/RepositoryEligibility.ts"
import { RulesetActivation } from "../../src/Labeling/Activation.ts"
import { activityPage } from "../../src/Labeling/Activity.ts"
import { LabelingConfiguration } from "../../src/Labeling/Configuration.ts"
import {
  DirectLabelingAdmission,
  type DirectLabelingIdentity,
  LabelItem,
  LabelItemLayer,
} from "../../src/Labeling/DirectLabeling.ts"
import type { ObservedItem } from "../../src/Labeling/Facts.ts"
import { Policies } from "../../src/Labeling/Policies.ts"
import { LabelingRules } from "../../src/Labeling/Rules.ts"
import { LabelingTest } from "../../src/Labeling/Test.ts"
import { SyncTargets } from "../../src/SyncTargets.ts"
import { WorkflowOutbox } from "../../src/WorkflowOutbox.ts"
import { MigratedPostgresLayer } from "../support/Postgres.ts"
import { FakeGitHub } from "./fakeGitHub.ts"

/**
 * Shared fixtures for the labeling suites: services, a repository with two
 * labels, two open pull requests, and the GitHub the direct path reads.
 */

/** The GitHub every suite reads; `seed` resets it. */
export const github = new FakeGitHub()

export const LabelingLayer = Layer.mergeAll(LabelingRules.layer, LabelingTest.layer).pipe(
  Layer.provideMerge(Policies.layer),
  Layer.provideMerge(LabelingConfiguration.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      SyncTargets.layer,
      GitHubReadModel.layer,
      RulesetActivation.layer,
      RepositoryEligibility.layer,
    ),
  ),
  Layer.provideMerge(WorkflowOutbox.layer),
)

/** Suites that never reach GitHub: any request is a test defect. */
export const NoGitHub = Layer.succeed(GitHubTransport, {
  request: (request) =>
    Effect.die(
      new Error(`Unexpected GitHub request in this suite: ${request.method} ${request.url}`),
    ),
})

export const Services = LabelingLayer.pipe(
  Layer.provide(github.layer),
  Layer.provideMerge(MigratedPostgresLayer),
)

/** The direct labeling workflow and its admission over the shared services. */
export const DirectLabelingLayer = Layer.mergeAll(LabelItemLayer, DirectLabelingAdmission.layer)

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
      permissions: { metadata: "read", issues: "write", pull_requests: "read", checks: "read" },
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
  github.issues.clear()
  github.requests.length = 0
  github.intercept = () => Effect.succeed(undefined)
  github.labels = [
    { id: 11, name: "bug" },
    { id: 12, name: "feature" },
  ]
})

/** Two open pull requests, on GitHub and in the UI cache: #5 against main, #6 against develop. */
export const seedPullRequests = Effect.gen(function* () {
  const readModel = yield* GitHubReadModel
  for (const [number, base] of [
    [5, "main"],
    [6, "develop"],
  ] as const) {
    github.put({
      number,
      title: `Change ${number}`,
      state: "open",
      labels: [],
      pullRequest: { baseRef: base },
    })
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

/**
 * "Now" for a webhook receipt, read from the database clock. Readiness is
 * stamped with that clock, so a host-clock `new Date()` can land in the same
 * instant or behind it on a busy runner and the event stops being eligible.
 * No lead is added: a later readiness stamp must still make this event stale.
 */
export const webhookNow = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<{ at: Date }>`SELECT clock_timestamp() AS at`
  return row!.at
})

// DIRECT LABELING

let sequence = 100

/** What a webhook would say about the item as the fake GitHub currently holds it. */
export const observed = (number: number): ObservedItem => {
  const issue = github.issues.get(number)
  if (issue === undefined) throw new Error(`No item #${number} on the fake GitHub`)
  const pull = github.pull(number)
  return {
    kind: pull === undefined ? "issue" : "pull_request",
    number,
    title: issue.title,
    authorLogin: issue.user?.login ?? "octocat",
    open: issue.state === "open" && pull?.merged !== true,
    baseRef: pull === undefined ? null : (pull.baseRef ?? "main"),
    draft: pull === undefined ? null : (pull.draft ?? false),
    labels: issue.labels.map((label) => GitHubLabelDatabaseId.make(String(label.id))),
  }
}

/** Admits the item as a new event would and returns the queued identity. */
export const admit = (number: number) =>
  Effect.gen(function* () {
    const admission = yield* DirectLabelingAdmission
    const result = yield* admission.admit({
      repositoryId,
      item: observed(number),
      sequence: GitHubWebhookJournalSequence.make(String(++sequence)),
    })
    if (result._tag !== "Admitted")
      return yield* Effect.die(new Error(`Expected admission, got ${result.reason}`))
    return result.identity
  })

/** Plans are read through repository activity, never retained by the workflow engine. */
export const executeAndReadActivity = (identity: DirectLabelingIdentity) =>
  Effect.gen(function* () {
    const result = yield* LabelItem.execute(identity)
    const page = yield* activityPage(identity.repositoryId, {
      search: "",
      target: "all",
      cursor: null,
    })
    const entry = page.entries.find(
      (entry) =>
        entry.number === identity.number &&
        entry.generation === identity.snapshotGeneration &&
        entry.revision === identity.rulesRevision,
    )
    assert.isDefined(entry)
    return { ...result, plan: entry?.plan ?? null }
  })

/** Admits and labels one item, returning the recorded outcome and plan. */
export const label = (number: number) => Effect.flatMap(admit(number), executeAndReadActivity)

/** The services automatic-labeling suites run: the workflow, admission and an in-memory engine. */
export const AutomaticLabelingServices = DirectLabelingLayer.pipe(
  Layer.provideMerge(LabelingLayer),
  Layer.provideMerge(github.layer),
  Layer.provideMerge(WorkflowEngine.layerMemory),
  Layer.provideMerge(MigratedPostgresLayer),
)
