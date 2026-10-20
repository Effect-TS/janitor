import { assert, describe, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import { GitHubLabelDatabaseId, GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { RepositoryNotFound } from "@janitor/domain/GitHub/Repository"
import { SyncGeneration } from "@janitor/domain/GitHub/Sync"
import { GitHubWebhookJournalSequence } from "@janitor/domain/GitHub/WebhookJournal"
import type { ActivityCursor, ActivityPage } from "@janitor/domain/Labeling/Activity"
import { PolicyId } from "@janitor/domain/Labeling/Policy/Condition"
import {
  type Actor,
  type AiConsent,
  type AuditEntry,
  type ConfigurationView,
  LabelingRevision,
} from "@janitor/domain/Labeling/Policy/Configuration"
import { describeCatalog } from "@janitor/domain/Labeling/Policy/Facts"
import type {
  ReconciliationRecord,
  RepositoryOverview,
} from "@janitor/domain/Labeling/Reconciliation"
import { LabelingGroupLayer } from "../../src/Ingress/Labeling.ts"
import { CurrentAccessIdentity } from "../../src/Ingress/Middleware.ts"
import { ActivityReader } from "../../src/Labeling/Activity.ts"
import { AiConsentService } from "../../src/Labeling/Classifier.ts"
import { LabelingConfiguration } from "../../src/Labeling/Configuration.ts"
import { LabelingOverview } from "../../src/Labeling/Overview.ts"
import { LabelingRules } from "../../src/Labeling/Rules.ts"
import { makeClient, unused } from "../support/Api.ts"

const repositoryId = GitHubRepositoryDatabaseId.make("701")
const at = DateTime.makeUnsafe("2026-09-03T12:00:00.000Z")
const identity = {
  issuer: "https://team.cloudflareaccess.test",
  subject: "user-1",
  email: undefined,
  expiresAt: at,
}

const repository: RepositoryOverview = {
  repositoryId,
  owner: "octo",
  repo: "janitor",
  enabled: true,
  ruleCount: 1,
  policyCount: 1,
  access: "accessible",
  configuredRevision: LabelingRevision.make(1),
  activeRevision: null,
}
const reconciliation: ReconciliationRecord = {
  repositoryId,
  number: 5,
  snapshotGeneration: SyncGeneration.make("3"),
  rulesRevision: LabelingRevision.make(1),
  coveredSequence: GitHubWebhookJournalSequence.make("9"),
  fingerprint: "abc",
  createdAt: at,
  outcome: null,
  detail: null,
  plan: null,
  actions: [],
  completedAt: null,
}
const view: ConfigurationView = {
  repositoryId,
  configuredRevision: LabelingRevision.make(1),
  activeRevision: null,
  policies: [],
  rules: [],
  labels: [{ labelId: GitHubLabelDatabaseId.make("11"), name: "bug", availability: "available" }],
  labelFreshness: "verified",
}
const cursor: ActivityCursor = { number: 5, generation: "3", revision: 1 }
const page: ActivityPage = {
  entries: [
    {
      id: "5:3:1",
      number: 5,
      title: "Fix the build",
      kind: "pull_request",
      createdAt: at,
      outcome: "evaluated",
      detail: null,
      revision: 1,
      plan: null,
      actions: [],
    },
  ],
  cursor,
}
const audit: AuditEntry = {
  auditId: "audit-1",
  repositoryId,
  subject: { _tag: "Policy", policyId: PolicyId.make("policy-1") },
  actor: { issuer: identity.issuer, subject: identity.subject },
  operation: "publish",
  before: null,
  after: null,
  createdAt: at,
}
const consent = (state: AiConsent["state"]): AiConsent => ({
  repositoryId,
  state,
  provider: "openrouter",
  model: "typesafe/jev-1.13",
  activeLeases: 0,
  updatedAt: at,
})

/** The activity queries the reader received, in order. */
const queries: Array<Parameters<ActivityReader["Service"]["page"]>[1]> = []
/** The actor each consent change was made as, in order. */
const actors: Array<Actor> = []

const overview = (
  overrides: Partial<LabelingOverview["Service"]> = {},
): LabelingOverview["Service"] => ({
  repositories: Effect.succeed([repository]),
  reconciliations: () => Effect.succeed([reconciliation]),
  ...overrides,
})

const configuration = (
  overrides: Partial<LabelingConfiguration["Service"]> = {},
): LabelingConfiguration["Service"] => ({
  ...unused(LabelingConfiguration),
  requireRepository: () => Effect.void,
  view: () => Effect.succeed(view),
  ...overrides,
})

const reader = (overrides: Partial<ActivityReader["Service"]> = {}): ActivityReader["Service"] => ({
  page: (_, query) => Effect.sync(() => queries.push(query)).pipe(Effect.as(page)),
  ...overrides,
})

const consentService = (
  overrides: Partial<AiConsentService["Service"]> = {},
): AiConsentService["Service"] => ({
  ...unused(AiConsentService),
  get: () => Effect.succeed(consent("disabled")),
  set: (_, enabled, actor) =>
    Effect.sync(() => actors.push(actor)).pipe(
      Effect.as(consent(enabled ? "enabled" : "disabled")),
    ),
  ...overrides,
})

const rules = (overrides: Partial<LabelingRules["Service"]> = {}): LabelingRules["Service"] => ({
  ...unused(LabelingRules),
  audit: () => Effect.succeed([audit]),
  ...overrides,
})

const client = (
  options: {
    readonly overview?: LabelingOverview["Service"]
    readonly configuration?: LabelingConfiguration["Service"]
    readonly reader?: ActivityReader["Service"]
    readonly consent?: AiConsentService["Service"]
    readonly rules?: LabelingRules["Service"]
  } = {},
) =>
  makeClient(
    ["labeling"],
    LabelingGroupLayer,
    Context.make(LabelingOverview, options.overview ?? overview()).pipe(
      Context.add(LabelingConfiguration, options.configuration ?? configuration()),
      Context.add(ActivityReader, options.reader ?? reader()),
      Context.add(AiConsentService, options.consent ?? consentService()),
      Context.add(LabelingRules, options.rules ?? rules()),
      Context.add(CurrentAccessIdentity, identity),
    ),
  )

const params = { repositoryId }

describe("labeling", () => {
  it.effect("serves the overview, configuration, activity, audit and AI consent", () =>
    Effect.gen(function* () {
      const api = yield* client()
      queries.length = 0
      actors.length = 0
      assert.deepStrictEqual(yield* api.labeling.listRepositories(), [repository])
      assert.deepStrictEqual(yield* api.labeling.getCatalog(), describeCatalog())
      assert.deepStrictEqual(yield* api.labeling.getConfiguration({ params }), view)
      assert.deepStrictEqual(yield* api.labeling.listReconciliations({ params }), [reconciliation])
      assert.deepStrictEqual(yield* api.labeling.listAudit({ params }), [audit])

      // An omitted query reads the first page of everything.
      assert.deepStrictEqual(yield* api.labeling.listActivity({ params, query: {} }), page)
      assert.deepStrictEqual(
        yield* api.labeling.listActivity({
          params,
          query: { search: "fix", target: "pull_request", cursor },
        }),
        page,
      )
      assert.deepStrictEqual(queries, [
        { search: "", target: "all", cursor: null },
        { search: "fix", target: "pull_request", cursor },
      ])

      assert.deepStrictEqual(yield* api.labeling.getAiConsent({ params }), consent("disabled"))
      assert.deepStrictEqual(
        yield* api.labeling.updateAiConsent({ params, payload: { enabled: true } }),
        consent("enabled"),
      )
      assert.deepStrictEqual(actors, [{ issuer: identity.issuer, subject: identity.subject }])
    }),
  )

  it.effect("refuses an unknown repository", () =>
    Effect.gen(function* () {
      const missing = new RepositoryNotFound({ repositoryId })

      const gone = yield* client({
        configuration: configuration({
          requireRepository: () => Effect.fail(missing),
          view: () => Effect.fail(missing),
        }),
        reader: reader({ page: () => Effect.fail(missing) }),
        rules: rules({ audit: () => Effect.fail(missing) }),
      })
      assert.deepStrictEqual(
        yield* gone.labeling.getConfiguration({ params }).pipe(Effect.flip),
        missing,
      )
      assert.deepStrictEqual(
        yield* gone.labeling.listActivity({ params, query: {} }).pipe(Effect.flip),
        missing,
      )
      assert.deepStrictEqual(yield* gone.labeling.listAudit({ params }).pipe(Effect.flip), missing)
      assert.deepStrictEqual(
        yield* gone.labeling.getAiConsent({ params }).pipe(Effect.flip),
        missing,
      )
      assert.deepStrictEqual(
        yield* gone.labeling
          .updateAiConsent({ params, payload: { enabled: true } })
          .pipe(Effect.flip),
        missing,
      )
    }),
  )
})
