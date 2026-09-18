import { SlackSession, SessionObjectLive } from "./Slack/SessionObject.ts"
import { makeSessionRuntime, SessionRuntime } from "./Slack/SessionRuntime.ts"
import { layerRepositories } from "./Slack/Repositories.ts"
import { SessionAdmission, SessionIngressLive } from "./Slack/SessionIngress.ts"
import { SlackSessionRoutes } from "./Ingress/SlackSession.ts"
import * as ConfigProvider from "effect/ConfigProvider"
import { RepositoryEligibility } from "./RepositoryEligibility.ts"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import { RepositoryLive } from "./LiveHub.ts"
import { liveUpdatesLayer, flushLive } from "./LiveUpdates.ts"
import type { LiveNamespace } from "./LiveUpdates.ts"
import { ActivityReader } from "./Labeling/Activity.ts"
import * as Schema from "effect/Schema"
import { RuleTestJobLayer, RuleTestJobRegistration, RuleTestJobs } from "./Labeling/RuleTestJob.ts"
import { RepositoryConnections } from "./RepositoryConnections.ts"
import { deployment } from "./Deployment.ts"
import { Readiness } from "./Ingress/Readiness.ts"
import {
  DiscoverInstallationsLayer,
  DiscoverInstallationsRegistration,
} from "./GitHub/DiscoverInstallations.ts"
import { LabelingSyncIntegrationLayer } from "./Labeling/SyncIntegration.ts"
import { LabelingAutomationIntegrationLayer } from "./Labeling/AutomationIntegration.ts"
import { LabelItemLayer, LabelItemRegistration } from "./Labeling/DirectLabeling.ts"
import {
  AdmitReviewLayer,
  AdmitReviewRegistration,
  IssueReviewAdmission,
} from "./Review/Admission.ts"
import { ReviewAgent, ReviewAgentClient, ReviewAgentLayer } from "./Review/Agent.ts"
import { ReviewActionDispatch } from "./Review/Actions.ts"
import { ReviewActionLayer, ReviewActionRegistration } from "./Review/Investigation.ts"
import {
  layerWorkspaceObjects,
  ReviewWorkspaceObject,
  ReviewWorkspaceObjectLive,
} from "./Review/WorkspaceObject.ts"
import { agentModel } from "./AgentModel.ts"
import { IssueReviewControl } from "./Review/Control.ts"
import { IssueReviewAvailable } from "./Review/Gate.ts"
import { IssueReviewScheduler } from "./Review/Scheduler.ts"
import { IssueReviewSettings } from "./Review/Settings.ts"
import { IssueReviewStore } from "./Review/Store.ts"
import * as AlchemyCloudflareCluster from "@effect/platform-cloudflare/AlchemyCloudflareCluster"
import { ALCHEMY_DEV } from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Postgres from "alchemy/SQL/Postgres"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import * as Path from "effect/Path"
import * as Etag from "effect/unstable/http/Etag"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as HttpPlatform from "effect/unstable/http/HttpPlatform"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import { GitHubEventsDeadLetterQueue, GitHubEventsQueue } from "./GitHub/EventQueue.ts"
import { GitHubWebhookPayloadsBucket } from "./GitHub/PayloadStore.ts"
import { ingressSecrets } from "./Ingress/GitHubWebhook.ts"
import * as Access from "./Ingress/Access.ts"
import { makeRoutesLayer } from "./Ingress/Routes.ts"
import * as Config from "effect/Config"
import * as OpenAiClient from "@effect/ai-openai-compat/OpenAiClient"
import * as OpenAiLanguageModel from "@effect/ai-openai-compat/OpenAiLanguageModel"
import * as PayloadCipher from "./PayloadCipher.ts"
import * as Cause from "effect/Cause"
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { JanitorHyperdrive } from "./Database.ts"
import {
  GitHubEventsDeadLetter,
  GitHubPayloadReader,
  handleMessage,
} from "./GitHub/WebhookConsumer.ts"
import * as GitHubAppAuth from "./GitHub/AppAuth.ts"
import { GitHubBudget } from "./GitHub/RateBudget.ts"
import { GitHubHttpCache } from "./GitHub/HttpCache.ts"
import { GitHubReadModel } from "./GitHub/ReadModel.ts"
import { GitHubTransport } from "./GitHub/Transport.ts"
import {
  SyncInstallationInventoryLayer,
  SyncInstallationInventoryRegistration,
} from "./GitHub/SyncInstallationInventory.ts"
import { RefreshEntityLayer, RefreshEntityRegistration } from "./GitHub/RefreshEntity.ts"
import {
  SyncRepositoryTrackLayer,
  SyncRepositoryTrackRegistration,
} from "./GitHub/SyncRepositoryTrack.ts"
import { ContentPurge } from "./ContentPurge.ts"
import { RulesetActivation } from "./Labeling/Activation.ts"
import { LabelingOverview } from "./Labeling/Overview.ts"
import {
  AiClassifier,
  AiConsentService,
  ClassifierProvider,
  providerConfig,
  AiInputBudget,
  AiCacheTtl,
  aiCacheTtlConfig,
} from "./Labeling/Classifier.ts"
import { LabelingConfiguration } from "./Labeling/Configuration.ts"
import { Policies } from "./Labeling/Policies.ts"
import { LabelingRules } from "./Labeling/Rules.ts"
import { LabelingTest } from "./Labeling/Test.ts"
import { SyncPlanner } from "./SyncPlanner.ts"
import { SyncRepairCronLayer, SyncRepairCronName } from "./SyncRepairCron.ts"
import { SyncStatus } from "./SyncStatus.ts"
import { SyncTargets } from "./SyncTargets.ts"
import { GitHubWebhookJournal } from "./GitHub/WebhookJournal.ts"
import {
  ProjectGitHubWebhookLayer,
  ProjectGitHubWebhookRegistration,
} from "./GitHub/ProjectWebhook.ts"
import { WorkflowDispatcher } from "./WorkflowDispatcher.ts"
import { WorkflowOutbox, OutboxWake } from "./WorkflowOutbox.ts"
import { WorkflowOutboxCronLayer, WorkflowOutboxCronName } from "./WorkflowOutboxCron.ts"
import * as AccountLinking from "./AccountLinking.ts"
import { Teammates, TeammatesConfig } from "./Teammates.ts"
import { LOCAL_DEV_ISSUER } from "./Ingress/Middleware.ts"
import * as Redacted from "effect/Redacted"
import { SlackConfig } from "./Slack/Config.ts"
import { SlackTransport } from "./Slack/Transport.ts"

/** The hostname both Workers serve. The website Worker owns the domain. */
const ZONE = "effectful.co"
/**
 * The audience `alchemy dev` stamps on its simulated Access context. Real
 * audiences are 64 hex characters, so this can never match a deployed one.
 */
const LOCAL_DEV_AUDIENCE = "local-dev"
const LOCAL_DEV_EMAIL = "dev@janitor.local"

export default class ClusterWorker extends Cloudflare.Worker<ClusterWorker>()(
  "ClusterWorker",
  Effect.gen(function* () {
    // Under `alchemy dev` there is no edge: Access is not declared and the
    // local identity stands in for it. This must be the `Config` value and
    // not `AlchemyContext`: the bind phase is bundled into the Worker, and
    // that service exists only in the CLI process, so reading it here fails
    // at runtime with "Service not found: alchemy/Context".
    const dev = yield* ALCHEMY_DEV
    const localPort = yield* Config.Int("JANITOR_LOCAL_API_PORT").pipe(Config.withDefault(8787))
    const webPort = yield* Config.Int("JANITOR_LOCAL_WEB_PORT").pipe(Config.withDefault(1337))
    const target = yield* deployment
    const access = yield* Access.declare({ dev, domain: target.domain, stage: target.stage })

    // A deploy leaves the local audience empty and declares no simulated
    // identity, so the runtime fallback that admits header-less requests has
    // nothing it could ever match.
    const localDev = dev
      ? { audience: LOCAL_DEV_AUDIENCE, identity: { email: LOCAL_DEV_EMAIL } }
      : undefined

    return {
      main: import.meta.url,
      // The pinned local workerd is 1.20260704.1; newer dates fail at startup.
      compatibility: { date: dev ? "2026-07-04" : "2026-09-05", flags: ["nodejs_compat"] },
      // The website Worker holds the custom domain for this hostname. A route
      // is more specific than a custom domain, so the API paths land here and
      // everything else falls through to the website. Access protects the
      // hostname, so both are covered without either Worker enrolling.
      routes: dev ? [] : [{ pattern: `${target.domain}/api/v1/*`, zoneName: ZONE }],
      workersDev: false,
      observability: { enabled: true, headSamplingRate: 1 },
      limits: { cpuMs: 300_000 },
      // Read at init from the environment: the plan-phase Config interceptor
      // only binds values it can resolve from the deploy environment.
      env: {
        ACCESS_AUD: access?.aud ?? "",
        LOCAL_DEV_AUDIENCE: localDev?.audience ?? "",
        // Platform callbacks return to the browser at this origin.
        PUBLIC_ORIGIN: dev ? `http://localhost:${webPort}` : `https://${target.domain}`,
      },
      dev: {
        port: localPort,
        // Fail rather than drift to another port: the web app's dev proxy
        // and the README both name this one.
        strictPort: true,
        ...(localDev === undefined
          ? {}
          : { access: { aud: localDev.audience, identity: localDev.identity } }),
      },
    }
  }),
  Effect.gen(function* () {
    const hyperdrive = yield* Cloudflare.Hyperdrive.Connect(JanitorHyperdrive)

    const githubEventsQueue = yield* GitHubEventsQueue
    const githubDeadLetterQueue = yield* Cloudflare.Queues.WriteQueue(
      yield* GitHubEventsDeadLetterQueue,
    )
    const githubPayloadsBucket = yield* Cloudflare.R2.ReadWriteBucket(
      yield* GitHubWebhookPayloadsBucket,
    )

    const DatabaseLayer = Postgres.PostgresLayer({
      url: hyperdrive.connectionString,
    })

    // Every secret is read here, during init, so Alchemy binds it at deploy
    // time. The cluster layer is built lazily and cannot register bindings.
    const dev = yield* ALCHEMY_DEV
    const localCredentials = dev
      ? ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            JANITOR_GITHUB_WEBHOOK_SECRET: "janitor-local-webhook",
            JANITOR_GITHUB_WEBHOOK_PAYLOAD_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            JANITOR_GITHUB_WEBHOOK_PAYLOAD_KEY_ID: "local-v1",
            JANITOR_GITHUB_APP_ID: "local-disabled",
            JANITOR_GITHUB_APP_PRIVATE_KEY: "local-disabled",
          }),
        )
      : Layer.empty
    const secrets = yield* Config.unwrap(ingressSecrets).pipe(Effect.provide(localCredentials))
    // The classifier provider is optional: without a key every classifier
    // policy evaluates unknown, which preserves labels.
    const ai = yield* Config.unwrap(providerConfig)
    const cacheTtl = yield* aiCacheTtlConfig
    const inputBudget = yield* Config.schema(
      Schema.Int.check(Schema.isBetween({ minimum: 4000, maximum: 64000 })),
      "LABELING_AI_INPUT_BYTES",
    ).pipe(Config.withDefault(16000))
    const ProviderLayer = Option.match(ai.apiKey, {
      onNone: () => ClassifierProvider.unavailable,
      onSome: (apiKey) =>
        ClassifierProvider.fromLanguageModel({ provider: "openai", model: ai.model }).pipe(
          Layer.provide(
            OpenAiLanguageModel.layer({ model: ai.model, config: { max_completion_tokens: 1000 } }),
          ),
          Layer.provide(
            OpenAiClient.layer({
              apiKey,
              ...(Option.isSome(ai.apiUrl) ? { apiUrl: ai.apiUrl.value } : {}),
            }),
          ),
          Layer.provide(FetchHttpClient.layer),
        ),
    })
    const appCredentials = yield* Config.unwrap(
      GitHubAppAuth.config({
        appId: "JANITOR_GITHUB_APP_ID",
        privateKey: "JANITOR_GITHUB_APP_PRIVATE_KEY",
      }),
    ).pipe(Effect.provide(localCredentials))
    const GitHubPayloadCipherLayer = PayloadCipher.layerFrom(secrets.cipher)
    // The development gate (ticket 13): issue review is off in a deployment
    // until it is explicitly switched on; `alchemy dev` always has it.
    const reviewAvailable =
      dev ||
      (yield* Config.Boolean("JANITOR_ISSUE_REVIEW_DEVELOPMENT").pipe(Config.withDefault(false)))
    // Account linking is optional per platform; the account page says which
    // platforms this deployment can connect.
    const linking = yield* Config.unwrap(AccountLinking.linkingSecrets)
    const slackWorkspace = yield* Config.String("JANITOR_SLACK_WORKSPACE_ID").pipe(
      Config.withDefault(""),
    )
    const slackApp = yield* Config.String("JANITOR_SLACK_APP_ID").pipe(Config.withDefault(""))
    const slackBot = yield* Config.String("JANITOR_SLACK_BOT_USER_ID").pipe(Config.withDefault(""))
    const slackToken = yield* Config.Redacted("JANITOR_SLACK_BOT_TOKEN").pipe(
      Config.withDefault(Redacted.make("")),
    )
    const slackSecret = yield* Config.Redacted("JANITOR_SLACK_SIGNING_SECRET").pipe(
      Config.withDefault(Redacted.make("")),
    )
    const slackConfigured =
      slackWorkspace !== "" &&
      slackApp !== "" &&
      slackBot !== "" &&
      Redacted.value(slackToken) !== "" &&
      Redacted.value(slackSecret) !== ""

    const GitHubAuthLayer = dev
      ? Layer.succeed(GitHubAppAuth.GitHubAppAuth, {
          appJwt: Effect.fail(
            new GitHubAppAuth.GitHubAppAuthError({
              operation: "signJwt",
              message: "Live GitHub access is disabled in local development",
            }),
          ),
          installationToken: () =>
            Effect.fail(
              new GitHubAppAuth.GitHubAppAuthError({
                operation: "installationToken",
                message: "Live GitHub access is disabled in local development",
              }),
            ),
          invalidateInstallationToken: () => Effect.void,
        })
      : GitHubAppAuth.layerFrom(appCredentials)
    const GitHubTransportLayer = GitHubTransport.layer.pipe(
      Layer.provideMerge(GitHubAuthLayer),
      Layer.provideMerge(GitHubBudget.layer),
      Layer.provide(FetchHttpClient.layer),
    )

    yield* RepositoryLive
    const reviewWorkspaces = yield* ReviewWorkspaceObject.pipe(
      Effect.provide(ReviewWorkspaceObjectLive),
    )
    const model = yield* agentModel
    const liveEnvironment = yield* Cloudflare.Workers.WorkerEnvironment
    // Empty everywhere except under `alchemy dev`; see the bind phase.
    const localDevAudience =
      typeof liveEnvironment.LOCAL_DEV_AUDIENCE === "string" &&
      liveEnvironment.LOCAL_DEV_AUDIENCE.length > 0
        ? liveEnvironment.LOCAL_DEV_AUDIENCE
        : undefined
    const publicOrigin =
      typeof liveEnvironment.PUBLIC_ORIGIN === "string" ? liveEnvironment.PUBLIC_ORIGIN : ""
    // The simulated local identity is the initial admin under `alchemy dev`;
    // a deploy names its first admin by Access subject.
    const TeammatesConfigLayer = Layer.succeed(TeammatesConfig, {
      initialAdmin:
        localDevAudience === undefined
          ? Option.map(linking.initialAdminSubject, (subject) => ({
              issuer: `https://${Access.TEAM_DOMAIN}`,
              subject,
            }))
          : Option.some({ issuer: LOCAL_DEV_ISSUER, subject: LOCAL_DEV_EMAIL }),
    })
    if (!dev && Option.isNone(linking.initialAdminSubject)) {
      yield* Effect.logError(
        "JANITOR_INITIAL_ADMIN_SUBJECT is not set: every teammate is admitted as a member and nobody can manage the team",
      )
    }
    let notifyOutbox: Effect.Effect<void> = Effect.void
    const SlackLayers = slackConfigured
      ? yield* Effect.gen(function* () {
          const slackConfig = Layer.succeed(SlackConfig, {
            workspaceId: slackWorkspace,
            appId: slackApp,
            botUserId: slackBot,
            token: slackToken,
            signingSecret: slackSecret,
          })
          const transport = SlackTransport.layer.pipe(Layer.provide(slackConfig))
          if (Option.isNone(model))
            // Slack needs the agent model; the missing key is a configuration error.
            yield* Config.Redacted("JANITOR_AGENT_RUNNER_MODEL_API_KEY")
          const modelLayer = Option.getOrThrow(model)({ maxCompletionTokens: 2048 })
          const repositories = layerRepositories.pipe(
            Layer.provide(RepositoryEligibility.layer.pipe(Layer.provide(DatabaseLayer))),
            Layer.provide([GitHubAuthLayer, FetchHttpClient.layer]),
          )
          const runtime = Layer.effect(SessionRuntime, makeSessionRuntime).pipe(
            Layer.provide([repositories, modelLayer, transport]),
          )
          const sessions = yield* SlackSession.pipe(
            Effect.provide(SessionObjectLive.pipe(Layer.provide(runtime))),
          )
          return SessionIngressLive.pipe(
            Layer.provide([slackConfig, transport]),
            Layer.provide(
              Layer.succeed(SessionAdmission, {
                receive: (name, input) => sessions.getByName(name).receive(input),
              }),
            ),
          )
        })
      : Layer.empty
    const ClusterLayer = Layer.mergeAll(
      DiscoverInstallationsLayer,
      ProjectGitHubWebhookLayer,
      SyncInstallationInventoryLayer,
      SyncRepositoryTrackLayer,
      RefreshEntityLayer,
      LabelItemLayer,
      RuleTestJobLayer,
      AdmitReviewLayer,
      ReviewAgentLayer,
      ReviewActionLayer.pipe(
        Layer.provide(
          Option.match(model, {
            onNone: () => Layer.empty,
            onSome: (make) => make({ maxCompletionTokens: 4096 }),
          }),
        ),
      ),
      WorkflowOutboxCronLayer,
      SyncRepairCronLayer,
      SlackLayers,
    ).pipe(
      Layer.provideMerge(
        Layer.mergeAll(LabelingSyncIntegrationLayer, LabelingAutomationIntegrationLayer),
      ),
      Layer.provideMerge(
        Layer.mergeAll(
          IssueReviewAdmission.layer,
          IssueReviewSettings.layer,
          IssueReviewControl.layer,
        ),
      ),
      Layer.provideMerge(IssueReviewScheduler.layer),
      Layer.provideMerge(
        Layer.mergeAll(
          IssueReviewStore.layer,
          ReviewAgentClient.layer,
          ReviewActionDispatch.layer,
          layerWorkspaceObjects(reviewWorkspaces),
        ),
      ),
      Layer.provideMerge(
        Layer.mergeAll(
          SyncPlanner.layer,
          SyncStatus.layer,
          RepositoryConnections.layer,
          AccountLinking.AccountLinking.layer.pipe(
            Layer.provide(AccountLinking.configLayer(linking, publicOrigin)),
            Layer.provide(FetchHttpClient.layer),
          ),
          LabelingRules.layer,
          LabelingTest.layer,
          RuleTestJobs.layer,
          LabelingOverview.layer,
          ActivityReader.layer,
        ),
      ),
      Layer.provideMerge(Policies.layer),
      Layer.provideMerge(Layer.mergeAll(LabelingConfiguration.layer, AiClassifier.layer)),
      Layer.provideMerge(AiConsentService.layer),
      Layer.provideMerge(ProviderLayer),
      Layer.provideMerge(
        WorkflowDispatcher.layer([
          DiscoverInstallationsRegistration,
          ProjectGitHubWebhookRegistration,
          SyncInstallationInventoryRegistration,
          SyncRepositoryTrackRegistration,
          RefreshEntityRegistration,
          LabelItemRegistration,
          RuleTestJobRegistration,
          AdmitReviewRegistration,
          ReviewActionRegistration,
        ]),
      ),
      Layer.provideMerge(GitHubTransportLayer),
      Layer.provideMerge(Teammates.layer.pipe(Layer.provide(TeammatesConfigLayer))),
      Layer.provideMerge(
        Layer.mergeAll(
          RepositoryEligibility.layer,
          GitHubWebhookJournal.layer,
          Readiness.layer,
          liveUpdatesLayer(liveEnvironment.RepositoryLive as LiveNamespace),
          GitHubReadModel.layer,
          SyncTargets.layer,
          ContentPurge.layer,
          GitHubHttpCache.layer.pipe(Layer.provide(GitHubPayloadCipherLayer)),
          GitHubPayloadReader.fromBucket(githubPayloadsBucket),
          GitHubEventsDeadLetter.fromQueue(githubDeadLetterQueue),
          GitHubPayloadCipherLayer,
          RulesetActivation.layer,
        ),
      ),
      Layer.provideMerge(WorkflowOutbox.layer),
      Layer.provide(DatabaseLayer),
      Layer.provide(Layer.succeed(AiInputBudget, inputBudget)),
      Layer.provide(Layer.succeed(AiCacheTtl, cacheTtl)),
      Layer.provide(Layer.succeed(IssueReviewAvailable, reviewAvailable)),
      Layer.provide(
        Layer.succeed(
          OutboxWake,
          Effect.suspend(() => notifyOutbox),
        ),
      ),
    )

    const cluster = yield* AlchemyCloudflareCluster.make({
      entities: [ReviewAgent],
      layer: ClusterLayer,
    })
    const wakeOutboxDispatch = cluster.wake(WorkflowOutboxCronName)
    notifyOutbox = wakeOutboxDispatch()
    const wakeSyncRepair = cluster.wake(SyncRepairCronName)
    yield* Cloudflare.Workers.cron("* * * * *", () =>
      Effect.all([wakeOutboxDispatch(), wakeSyncRepair()], {
        discard: true,
      }),
    )

    yield* Cloudflare.Queues.consumeQueueMessages(
      githubEventsQueue,
      { batchSize: 10, maxRetries: 10, retryDelay: "1 minute" },
      (messages) =>
        cluster.provide(
          Stream.runForEach(messages, (message) =>
            handleMessage(message).pipe(
              Effect.catchCause(
                Effect.fnUntraced(function* (cause) {
                  yield* Effect.logError("GitHub webhook consumer defect", cause).pipe(
                    Effect.annotateLogs({ messageId: message.id }),
                  )
                  message.retry()
                }),
              ),
            ),
          ),
        ),
    )

    // Signed webhook ingress and the human sync routes live in the same
    // deployment as the consumer and workflows, so there is no internal hop
    // between acceptance and journaling.
    const HttpPlatformStubLayer = Layer.succeed(HttpPlatform.HttpPlatform, {
      platform: "web",
      compression: {
        algorithms: new Set<HttpPlatform.CompressionAlgorithm>(),
        compressResponse: () =>
          Effect.die("HttpPlatform.compression.compressResponse not supported"),
      },
      fileResponse: () => Effect.die("HttpPlatform.fileResponse not supported"),
      fileWebResponse: () => Effect.die("HttpPlatform.fileWebResponse not supported"),
    })
    const env = yield* Cloudflare.Workers.WorkerEnvironment
    // The audience binding is empty during plan, when no request can arrive.
    // At runtime an empty audience matches no assertion, so a missing binding
    // fails closed rather than open.
    const accessAudience = typeof env.ACCESS_AUD === "string" ? env.ACCESS_AUD : ""
    const apiRoutes = yield* HttpRouter.toHttpEffect(
      Layer.mergeAll(
        makeRoutesLayer(
          secrets,
          { teamDomain: Access.TEAM_DOMAIN, audience: accessAudience },
          { localDevAudience },
        ),
        slackConfigured ? SlackSessionRoutes : Layer.empty,
      ).pipe(Layer.provide([Etag.layer, HttpPlatformStubLayer, Path.layer, FetchHttpClient.layer])),
    )
    // Route errors that know their response (400 for a malformed request,
    // 404 for no route) become that response; anything else is a 500.
    const api = apiRoutes.pipe(
      Effect.catchCause((cause) => {
        const error = Cause.squash(cause)
        const expected = HttpServerRespondable.isRespondable(error)
        return (
          expected
            ? Effect.logWarning("API request rejected", cause)
            : Effect.logError("API request failed", cause)
        ).pipe(
          Effect.andThen(
            HttpServerRespondable.toResponseOrElseDefect(
              error,
              HttpServerResponse.empty({ status: 500 }),
            ),
          ),
        )
      }),
    )

    return {
      fetch: cluster.provide(
        api.pipe(
          Effect.tap((response) =>
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest
              if (response.status < 400 && request.method !== "GET" && request.method !== "HEAD") {
                const execution = yield* Cloudflare.Workers.WorkerExecutionContext
                yield* execution.waitUntil(flushLive)
              }
            }),
          ),
        ),
      ),
    }
  }).pipe(
    Effect.provide([
      Cloudflare.Hyperdrive.ConnectBinding,
      Cloudflare.Queues.WriteQueueBinding,
      Cloudflare.Queues.EventSourceLive,
      Cloudflare.R2.ReadWriteBucketBinding,
      Cloudflare.R2.WriteBucketBinding,
      Cloudflare.Workers.RateLimitBinding,
      Cloudflare.Workers.CronEventSourceLive,
    ]),
  ),
) {}
