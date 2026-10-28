import { assert, describe, it } from "@effect/vitest"
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as RuntimeContext from "alchemy/RuntimeContext"
import { Stack } from "alchemy/Stack"
import { Stage } from "alchemy/Stage"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServer from "effect/http/HttpServer"
import { TeammateId } from "@janitor/domain/Team/Account"
import type { SyncSummary } from "@janitor/domain/GitHub/Sync"
import { AccessVerifier } from "../../src/Ingress/AccessJwt.ts"
import { makeRoutesLayer } from "../../src/Ingress/Routes.ts"
import { SyncStatus } from "../../src/SyncStatus.ts"
import { Teammates } from "../../src/Teammates.ts"
import { WorkflowDispatcher } from "../../src/WorkflowDispatcher.ts"
import { AccountLinking } from "../../src/AccountLinking.ts"
import { GitHubReadModel } from "../../src/GitHub/ReadModel.ts"
import { GitHubWebhookJournal } from "../../src/GitHub/WebhookJournal.ts"
import { Readiness } from "../../src/Ingress/Readiness.ts"
import { ActivityReader } from "../../src/Labeling/Activity.ts"
import { AiConsentService } from "../../src/Labeling/Classifier.ts"
import { LabelingConfiguration } from "../../src/Labeling/Configuration.ts"
import { LabelingOverview } from "../../src/Labeling/Overview.ts"
import { Policies } from "../../src/Labeling/Policies.ts"
import { LabelingRules } from "../../src/Labeling/Rules.ts"
import { RuleTestJobs } from "../../src/Labeling/RuleTestJob.ts"
import { LabelingTest } from "../../src/Labeling/Test.ts"
import { RunTranscripts } from "../../src/PullRequestReview/RunEntity.ts"
import { ChatKillSwitchStore } from "../../src/Chat/KillSwitch.ts"
import { ChatSessionControl } from "../../src/Chat/Session.ts"
import { ChatSessionIndex } from "../../src/Chat/SessionIndex.ts"
import { RepositoryDisabler } from "../../src/PullRequestReview/Scheduler.ts"
import { PullRequestReviewStore } from "../../src/PullRequestReview/Store.ts"
import { RepositoryConnections } from "../../src/RepositoryConnections.ts"
import { RepositoryEligibility } from "../../src/RepositoryEligibility.ts"
import { unused } from "../support/Api.ts"

const runtimeContext = RuntimeContext.RuntimeContext.of({
  Type: "Test",
  id: "test",
  env: {},
  get: <A>() => Effect.succeed<A | undefined>(undefined),
  set: (id) => Effect.succeed(id),
})

const expiresAt = DateTime.makeUnsafe("2026-09-03T12:00:00.000Z")

const summary: SyncSummary = {
  state: "idle",
  lastVerifiedAt: null,
  pendingTargets: 0,
  blockedTargets: 0,
  failedTargets: 0,
}

/** What the Worker's bind phase supplies: bindings, Access keys and the stage. */
const WorkerLayer = Layer.mergeAll(
  Layer.succeed(AccessVerifier, {
    verify: (subject) => Effect.succeed({ issuer: "test", subject, email: undefined, expiresAt }),
  }),
  Layer.succeed(Cloudflare.RateLimit, () =>
    Effect.succeed({ raw: Effect.die("unused"), limit: () => Effect.succeed({ success: true }) }),
  ),
  Layer.succeed(Cloudflare.Workers.WorkerExecutionContext, {
    raw: {} as never,
    waitUntil: () => Effect.void,
    passThroughOnException: () => Effect.void,
    cache: { purge: () => Effect.die("unused") },
    props: Effect.succeed({}),
    exports: {},
    access: Effect.succeed(undefined),
  }),
  // The webhook routes bind a queue and a bucket when the layer is built;
  // nothing here sends to either.
  Layer.succeed(Cloudflare.Queues.WriteQueue, () => Effect.succeed({} as never)),
  Layer.succeed(Cloudflare.R2.WriteBucket, () => Effect.succeed({} as never)),
  Layer.succeed(Cloudflare.Providers, unused(Cloudflare.Providers)),
  Layer.succeed(Stack, {
    name: "test",
    stage: "production",
    resources: {},
    bindings: {},
    actions: {},
  }),
  Layer.succeed(Stage, "production"),
  HttpServer.layerServices,
)

const serviceContext = Context.make(SyncStatus, {
  summary: Effect.succeed(summary),
  requestAll: Effect.succeed({ summary, requested: 0 }),
  requestRepository: () => Effect.die("must not run"),
}).pipe(
  Context.add(AccountLinking, unused(AccountLinking)),
  Context.add(ActivityReader, unused(ActivityReader)),
  Context.add(AiConsentService, unused(AiConsentService)),
  Context.add(GitHubReadModel, unused(GitHubReadModel)),
  Context.add(GitHubWebhookJournal, unused(GitHubWebhookJournal)),
  Context.add(LabelingConfiguration, unused(LabelingConfiguration)),
  Context.add(LabelingOverview, unused(LabelingOverview)),
  Context.add(LabelingRules, unused(LabelingRules)),
  Context.add(LabelingTest, unused(LabelingTest)),
  Context.add(Policies, unused(Policies)),
  Context.add(PullRequestReviewStore, unused(PullRequestReviewStore)),
  Context.add(Readiness, unused(Readiness)),
  Context.add(RepositoryConnections, unused(RepositoryConnections)),
  Context.add(RepositoryDisabler, unused(RepositoryDisabler)),
  Context.add(RepositoryEligibility, unused(RepositoryEligibility)),
  Context.add(RuleTestJobs, unused(RuleTestJobs)),
  Context.add(RunTranscripts, unused(RunTranscripts)),
  Context.add(RuntimeContext.RuntimeContext, runtimeContext),
  Context.add(WorkflowDispatcher, {
    dispatchDue: () => Effect.succeed({ claimed: 0, accepted: 0, released: 0 }),
  }),
  Context.add(
    Teammates,
    Teammates.of({
      admit: (identity) =>
        Effect.succeed({
          teammateId: TeammateId.make(`teammate-${identity.subject}`),
          issuer: identity.issuer,
          subject: identity.subject,
          email: null,
          createdAt: expiresAt,
        }),
      account: () => Effect.die("unused"),
      disconnect: () => Effect.die("unused"),
      beginLink: () => Effect.die("unused"),
      consumeLinkAttempt: () => Effect.die("unused"),
      link: () => Effect.die("unused"),
    }),
  ),
)

const requestContext = Context.merge(
  serviceContext,
  Context.make(ChatKillSwitchStore, unused(ChatKillSwitchStore)).pipe(
    Context.add(ChatSessionControl, unused(ChatSessionControl)),
    Context.add(ChatSessionIndex, unused(ChatSessionIndex)),
  ),
)

const respond = (method: string, path: string, headers: Record<string, string>) =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        makeRoutesLayer(
          { webhookSecret: Redacted.make("unused") },
          { localDevAudience: undefined },
        ).pipe(Layer.provide(WorkerLayer)),
        { disableLogger: true },
      ),
    ),
    ({ handler }) =>
      Effect.promise(() =>
        handler(new Request(`https://janitor.example${path}`, { method, headers }), requestContext),
      ),
    ({ dispose }) => Effect.promise(dispose),
  )

const assertion = { "cf-access-jwt-assertion": "person" }

describe("makeRoutesLayer", () => {
  it.effect("serves the sync group once under /api/v1", () =>
    Effect.gen(function* () {
      const response = yield* respond("GET", "/api/v1/sync", assertion)
      assert.strictEqual(response.status, 200)
      assert.strictEqual((yield* Effect.promise(() => response.json())).state, "idle")
    }),
  )

  it.effect("answers 401 without an Access assertion", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* respond("GET", "/api/v1/sync", {})).status, 401)
    }),
  )

  it.effect("refuses a cross-site write and serves a cross-site read", () =>
    Effect.gen(function* () {
      const crossSite = { ...assertion, "sec-fetch-site": "cross-site" }
      assert.strictEqual((yield* respond("POST", "/api/v1/sync", crossSite)).status, 403)
      assert.strictEqual((yield* respond("GET", "/api/v1/sync", crossSite)).status, 200)
    }),
  )

  it.effect("answers 400 for a malformed path parameter", () =>
    Effect.gen(function* () {
      const response = yield* respond("POST", "/api/v1/repositories/not-a-number/sync", {
        ...assertion,
        "sec-fetch-site": "same-origin",
      })
      assert.strictEqual(response.status, 400)
    }),
  )
})
