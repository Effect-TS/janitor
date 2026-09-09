import * as Fiber from "effect/Fiber"
import { assert, layer } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as RuntimeContext from "alchemy/RuntimeContext"
import {
  GitHubRepositoryDatabaseId,
  GitHubLabelDatabaseId,
  GitHubLabelNodeId,
  GitHubWebhookDeliveryId,
} from "@janitor/domain/GitHub/Id"
import {
  GitHubWebhookEncryptionKeyId,
  GitHubWebhookName,
  GitHubWebhookPayloadSha256,
  type GitHubWebhookEnvelopeV1,
} from "@janitor/domain/GitHub/WebhookEnvelope"
import { GitHubWebhookJournalSequence } from "@janitor/domain/GitHub/WebhookJournal"
import { RepositoryConnections } from "../src/RepositoryConnections.ts"
import { RepositoryActivity } from "../src/RepositoryActivity.ts"
import { GitHubReadModel } from "../src/GitHub/ReadModel.ts"
import { GitHubTransport } from "../src/GitHub/Transport.ts"
import { GitHubWebhookJournal } from "../src/GitHub/WebhookJournal.ts"
import { projectDelivery } from "../src/GitHub/ProjectWebhook.ts"
import { ContentPurge } from "../src/ContentPurge.ts"
import { GitHubEventQueue } from "../src/GitHub/EventQueue.ts"
import { GitHubPayloadStore, payloadKey } from "../src/GitHub/PayloadStore.ts"
import { PayloadCipher, make as makeCipher } from "../src/PayloadCipher.ts"
import { WebhookVerifier } from "../src/Ingress/WebhookVerifier.ts"
import { GitHubWebhookRoutesLayerNoDeps } from "../src/Ingress/GitHubWebhook.ts"
import { SyncStatus } from "../src/SyncStatus.ts"
import { SyncTargets } from "../src/SyncTargets.ts"
import { WorkflowOutbox } from "../src/WorkflowOutbox.ts"
import { MigratedPostgresLayer } from "./support/Postgres.ts"

const repositoryId = GitHubRepositoryDatabaseId.make("9100")
const actor = { issuer: "test", subject: "operator" }
const Services = Layer.mergeAll(
  RepositoryConnections.layer,
  RepositoryActivity.layer,
  SyncStatus.layer,
  GitHubWebhookJournal.layer,
  ContentPurge.layer,
).pipe(
  Layer.provideMerge(SyncTargets.layer),
  Layer.provideMerge(GitHubReadModel.layer),
  Layer.provideMerge(WorkflowOutbox.layer),
  Layer.provideMerge(MigratedPostgresLayer),
  Layer.provideMerge(
    Layer.effect(
      PayloadCipher,
      makeCipher({ key: new Uint8Array(32), keyId: GitHubWebhookEncryptionKeyId.make("test") }),
    ),
  ),
  Layer.provide(
    Layer.succeed(GitHubTransport, {
      request: (request) =>
        Effect.succeed({
          _tag: "Ok",
          status: 200,
          body: request.url.startsWith("/app/installations/")
            ? {
                id: 77,
                account: { id: 1, login: "test", type: "Organization" },
                repository_selection: "selected",
                html_url: "https://github.com/settings/installations/77",
                suspended_at: null,
                permissions: {
                  metadata: "read",
                  issues: "write",
                  pull_requests: "read",
                  checks: "read",
                },
              }
            : { id: 9100 },
          etag: Option.none(),
          link: Option.none(),
          requestId: Option.none(),
        }),
    }),
  ),
)
const scope = { _tag: "RepositoryTrack", repositoryId, track: "labels" } as const
const label = {
  id: GitHubLabelDatabaseId.make("990"),
  nodeId: GitHubLabelNodeId.make("LA_990"),
  name: "retained",
}
const initialize = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO github_installation(access_error,installation_id,account_database_id,account_handle,account_type,repository_selection,status,html_url,projected_sequence) VALUES(NULL,'77','1','test','Organization','selected','active','https://github.com/settings/installations/77',1) ON CONFLICT DO NOTHING`
  yield* sql`UPDATE github_repository SET enabled=FALSE WHERE repository_id=${repositoryId}`
  yield* sql`INSERT INTO github_repository(repository_id,installation_id,owner,repo,connected,enabled,access,projected_sequence) VALUES(${repositoryId},'77','test','example',TRUE,TRUE,'accessible',1) ON CONFLICT (repository_id) DO UPDATE SET enabled=TRUE`
})

layer(Services, { timeout: "2 minutes" })("Repository pause", (it) => {
  it.effect(
    "drops signed small and overflow payloads before storage, but retains installation discovery",
    () =>
      Effect.gen(function* () {
        yield* initialize
        const connections = yield* RepositoryConnections
        const activity = yield* RepositoryActivity
        const cipher = yield* PayloadCipher
        const ingressJournal = yield* GitHubWebhookJournal
        const envelopes: Array<GitHubWebhookEnvelopeV1> = []
        let stored = 0
        let verification: Effect.Effect<boolean> = Effect.succeed(true)
        const { handler } = yield* Effect.acquireRelease(
          Effect.sync(() =>
            HttpRouter.toWebHandler(
              GitHubWebhookRoutesLayerNoDeps.pipe(
                Layer.provide([
                  Layer.succeed(WebhookVerifier, {
                    verify: () => Effect.suspend(() => verification),
                  }),
                  Layer.succeed(PayloadCipher, cipher),
                  Layer.succeed(GitHubEventQueue, {
                    enqueue: (envelope) => Effect.sync(() => void envelopes.push(envelope)),
                  }),
                  Layer.succeed(GitHubPayloadStore, {
                    put: (input) =>
                      Effect.sync(() => {
                        stored++
                        return payloadKey(input.deliveryId)
                      }),
                    delete: () => Effect.void,
                  }),
                ]),
              ),
              {
                disableLogger: true,
                middleware: (app) =>
                  app.pipe(
                    Effect.provideService(RepositoryActivity, activity),
                    Effect.provideService(GitHubWebhookJournal, ingressJournal),
                    Effect.provideService(
                      RuntimeContext.RuntimeContext,
                      RuntimeContext.RuntimeContext.of({
                        Type: "Test",
                        id: "test",
                        env: {},
                        get: <A>() => Effect.succeed<A | undefined>(undefined),
                        set: (id) => Effect.succeed(id),
                      }),
                    ),
                  ),
              },
            ),
          ),
          ({ dispose }) => Effect.promise(dispose),
        )
        const post = (event: string, padding: number) =>
          Effect.promise(() =>
            handler(
              new Request("https://example.test/webhooks/github", {
                method: "POST",
                headers: {
                  "x-github-delivery": "test",
                  "x-github-event": event,
                  "x-hub-signature-256": "signed",
                },
                body: JSON.stringify({ repository: { id: 9100 }, padding: "x".repeat(padding) }),
              }),
            ),
          )
        assert.strictEqual((yield* post("pull_request", 0)).status, 202)
        assert.strictEqual(envelopes.length, 0)
        assert.isTrue(
          Option.isSome(yield* ingressJournal.load(GitHubWebhookDeliveryId.make("test"))),
        )
        yield* connections.change(repositoryId, "pause", actor)
        for (const padding of [0, 70000])
          assert.strictEqual((yield* post("pull_request", padding)).status, 202)
        assert.strictEqual(envelopes.length, 0)
        assert.strictEqual(stored, 0)
        assert.strictEqual((yield* post("installation_repositories", 0)).status, 202)
        assert.strictEqual(envelopes.length, 1)
        assert.isFalse((yield* connections.inventory).repositories[0]!.enabled)
        const denied = yield* Effect.flip((yield* SyncStatus).requestRepository(repositoryId))
        assert.include(denied.message, "Resume")
        const verifying = yield* Deferred.make<void>()
        const verified = yield* Deferred.make<void>()
        verification = Deferred.succeed(verifying, undefined).pipe(
          Effect.andThen(Deferred.await(verified)),
          Effect.as(true),
        )
        const arrivingWhilePaused = yield* post("pull_request", 70000).pipe(Effect.forkChild)
        yield* Deferred.await(verifying)
        yield* connections.change(repositoryId, "resume", actor)
        yield* Deferred.succeed(verified, undefined)
        assert.strictEqual((yield* Fiber.join(arrivingWhilePaused)).status, 202)
        assert.strictEqual(envelopes.length, 1)
        assert.strictEqual(stored, 0)
      }),
  )

  it.effect(
    "rejects a late fact publication after pause and after resume, retaining the old catalog",
    () =>
      Effect.gen(function* () {
        yield* initialize
        const targets = yield* SyncTargets
        const readModel = yield* GitHubReadModel
        const connections = yield* RepositoryConnections
        yield* readModel.applyLabelCatalog({
          repositoryId,
          labels: [label],
          sequence: GitHubWebhookJournalSequence.make("1"),
        })
        const before = yield* readModel.listLabels(repositoryId)
        const run = yield* targets.invalidate({ scope, sequence: Option.none() })
        yield* targets.begin(scope, run.generation)
        // The GitHub response is ready only after pause commits.
        yield* connections.change(repositoryId, "pause", actor)
        const publish = targets.withRun(
          scope,
          run.generation,
          readModel.applyLabelCatalog({
            repositoryId,
            labels: [],
            sequence: GitHubWebhookJournalSequence.make("9"),
          }),
        )
        assert.isTrue(Option.isNone(yield* publish))
        yield* connections.change(repositoryId, "resume", actor)
        assert.isTrue(Option.isNone(yield* publish))
        assert.deepStrictEqual(yield* readModel.listLabels(repositoryId), before)
      }),
  )

  it.effect("waits for an active fact publication before acknowledging pause", () =>
    Effect.gen(function* () {
      yield* initialize
      const targets = yield* SyncTargets
      const connections = yield* RepositoryConnections
      const readModel = yield* GitHubReadModel
      const run = yield* targets.invalidate({ scope, sequence: Option.none() })
      const begun = yield* targets.begin(scope, run.generation)
      assert.strictEqual(begun._tag, "Run")
      if (begun._tag !== "Run") return
      const writing = yield* Deferred.make<void>()
      const pausing = yield* Deferred.make<void>()
      const order: Array<string> = []
      yield* Effect.all(
        [
          targets.withRun(
            scope,
            begun.generation,
            Effect.gen(function* () {
              yield* Deferred.succeed(writing, undefined)
              yield* Deferred.await(pausing)
              yield* readModel.applyLabelCatalog({
                repositoryId,
                labels: [label],
                sequence: GitHubWebhookJournalSequence.make("10"),
              })
              order.push("published")
            }),
          ),
          Deferred.await(writing).pipe(
            Effect.andThen(Deferred.succeed(pausing, undefined)),
            Effect.andThen(connections.change(repositoryId, "pause", actor)),
            Effect.tap(() => Effect.sync(() => order.push("paused"))),
          ),
        ],
        { concurrency: 2 },
      )
      assert.deepStrictEqual(order, ["published", "paused"])
      assert.isFalse((yield* connections.inventory).repositories[0]!.enabled)
    }),
  )

  it.effect("discards queued webhook facts across pause and resume", () =>
    Effect.gen(function* () {
      yield* initialize
      const journal = yield* GitHubWebhookJournal
      const cipher = yield* PayloadCipher
      const connections = yield* RepositoryConnections
      const readModel = yield* GitHubReadModel
      const deliveryId = GitHubWebhookDeliveryId.make("before-pause")
      const payload = new TextEncoder().encode(
        JSON.stringify({
          action: "opened",
          number: 42,
          repository: { id: 9100, full_name: "test/example" },
          installation: { id: 77 },
          sender: { id: 1, login: "test" },
          pull_request: {
            id: 42,
            number: 42,
            node_id: "PR_42",
            title: "Should not be stored",
            body: null,
            state: "open",
            draft: false,
            merged: false,
            updated_at: "2026-09-01T00:00:00Z",
            labels: [],
            user: { login: "test" },
            head: { sha: "a".repeat(40) },
            base: { ref: "main" },
          },
        }),
      )
      const encrypted = yield* cipher.encrypt(deliveryId, payload)
      yield* journal.record({
        deliveryId,
        eventName: GitHubWebhookName.make("pull_request"),
        receivedAt: DateTime.makeUnsafe(0),
        payloadSha256: GitHubWebhookPayloadSha256.make("a".repeat(64)),
        encryption: encrypted.encryption,
        payload: encrypted.ciphertext,
      })
      yield* connections.change(repositoryId, "pause", actor)
      yield* connections.change(repositoryId, "resume", actor)
      yield* projectDelivery(deliveryId)
      assert.isTrue(Option.isNone(yield* readModel.getEntity(repositoryId, 42)))
      assert.strictEqual(
        Option.getOrThrow(yield* journal.load(deliveryId)).projectionStatus,
        "unsupported",
      )
    }),
  )
})
