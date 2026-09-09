import { TestPayloadCipher } from "./support/PayloadCipher.ts"
import { assert, layer } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as DateTime from "effect/DateTime"
import * as Schema from "effect/Schema"
import * as RuntimeContext from "alchemy/RuntimeContext"
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { GitHubReadModel } from "../src/GitHub/ReadModel.ts"
import { RepositoryConnections } from "../src/RepositoryConnections.ts"
import { GitHubTransport } from "../src/GitHub/Transport.ts"
import { SyncTargets } from "../src/SyncTargets.ts"
import { WorkflowOutbox } from "../src/WorkflowOutbox.ts"
import { MigratedPostgresLayer } from "./support/Postgres.ts"
import { PayloadCipher } from "../src/PayloadCipher.ts"
import { GitHubWebhookJournal } from "../src/GitHub/WebhookJournal.ts"
import {
  handleMessage,
  GitHubPayloadReader,
  GitHubEventsDeadLetter,
} from "../src/GitHub/WebhookConsumer.ts"
import { WorkflowDispatcher } from "../src/WorkflowDispatcher.ts"
import { GitHubRepositoryDatabaseId, GitHubWebhookDeliveryId } from "@janitor/domain/GitHub/Id"
import {
  GitHubWebhookName,
  GitHubWebhookPayloadSha256,
  GitHubWebhookEnvelopeV1,
  GitHubWebhookR2ObjectKey,
} from "@janitor/domain/GitHub/WebhookEnvelope"
const Services = RepositoryConnections.layer.pipe(
  Layer.provideMerge(WorkflowDispatcher.layer([])),
  Layer.provideMerge(WorkflowEngine.layerMemory),
  Layer.provideMerge(GitHubWebhookJournal.layer),
  Layer.provideMerge(TestPayloadCipher),
  Layer.provideMerge(SyncTargets.layer),
  Layer.provideMerge(GitHubReadModel.layer),
  Layer.provideMerge(WorkflowOutbox.layer),
  Layer.provideMerge(MigratedPostgresLayer),
  Layer.provide(
    Layer.succeed(
      GitHubTransport,
      GitHubTransport.of({
        request: (request) =>
          Effect.succeed({
            _tag: "Ok",
            status: 200,
            body:
              request.url === "/app"
                ? { slug: "janitor" }
                : request.url.startsWith("/app/installations?")
                  ? [
                      {
                        id: 88,
                        account: { id: 2, login: "new-org", type: "Organization" },
                        repository_selection: "selected",
                        html_url: "https://github.com/settings/installations/88",
                        suspended_at: null,
                      },
                    ]
                  : request.url.startsWith("/installation/repositories")
                    ? {
                        total_count: 1,
                        repositories: [{ id: 9002, full_name: "new-org/new-repo", private: false }],
                      }
                    : { id: 9001 },
            etag: Option.none(),
            link: Option.none(),
            requestId: Option.none(),
          }),
      }),
    ),
  ),
)
const actor = { issuer: "test", subject: "operator" }
layer(Services, { timeout: "2 minutes" })("Repository connections", (it) => {
  it.effect(
    "deletes configuration on disconnect and reconnects through fresh synchronization",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const connections = yield* RepositoryConnections
        yield* sql`INSERT INTO github_installation(installation_id,account_database_id,account_handle,account_type,repository_selection,status,html_url,projected_sequence) VALUES('77','1','test','Organization','selected','active','https://github.com/settings/installations/77',1)`
        yield* sql`INSERT INTO github_repository(repository_id,installation_id,owner,repo,connected,access,projected_sequence) VALUES('9001','77','test','example',FALSE,'accessible',1)`
        assert.isFalse((yield* connections.inventory).repositories[0]!.connected)
        yield* connections.change("9001", "connect", actor)
        yield* connections.change("9001", "connect", actor)
        assert.isTrue((yield* connections.inventory).repositories[0]!.enabled)
        const audit = yield* sql`SELECT action FROM repository_connection_audit`
        assert.deepStrictEqual(audit, [{ action: "connect" }])
        assert.strictEqual((yield* sql`SELECT scope FROM sync_target`).length, 3)
        yield* sql`INSERT INTO labeling_policy(policy_id,repository_id,name,target,version) VALUES('disconnect-policy','9001','Old policy','issue',1)`
        yield* sql`INSERT INTO labeling_policy_draft(policy_id,program) VALUES('disconnect-policy','{}')`
        yield* connections.change("9001", "disconnect", actor)
        yield* connections.change("9001", "disconnect", actor)
        const disconnected = (yield* connections.inventory).repositories[0]!
        assert.isFalse(disconnected.connected)
        assert.isFalse(disconnected.enabled)
        assert.isTrue(disconnected.reconnect)
        assert.strictEqual(disconnected.policyCount, 0)
        assert.deepStrictEqual(yield* sql`SELECT * FROM labeling_policy_draft`, [])
        assert.deepStrictEqual(yield* sql`SELECT * FROM sync_target`, [])
        assert.isFalse(
          (yield* sql<{
            eligible: boolean
          }>`SELECT sync_scope_enabled('{"_tag":"RepositoryTrack","repositoryId":"9001","track":"labels"}') AS eligible`)[0]!
            .eligible,
        )
        const denied = yield* Effect.flip(connections.change("9001", "resume", actor))
        assert.include(denied.message, "Reconnect")
        // Older releases retained configuration even while disconnected.
        yield* sql`INSERT INTO labeling_policy(policy_id,repository_id,name,target,version) VALUES('legacy-retained','9001','Legacy retained','issue',1)`
        yield* connections.change("9001", "disconnect", actor)
        assert.strictEqual((yield* connections.inventory).repositories[0]!.policyCount, 0)
        yield* sql`INSERT INTO labeling_policy(policy_id,repository_id,name,target,version) VALUES('legacy-reconnect','9001','Legacy reconnect','issue',1)`
        yield* connections.change("9001", "connect", actor)
        assert.isTrue((yield* connections.inventory).repositories[0]!.enabled)
        assert.strictEqual((yield* connections.inventory).repositories[0]!.policyCount, 0)
        assert.strictEqual((yield* connections.inventory).repositories[0]!.syncState, "syncing")
        yield* connections.change("9001", "resume", actor)
        assert.isTrue((yield* connections.inventory).repositories[0]!.enabled)
        yield* sql`UPDATE github_repository SET access='lost' WHERE repository_id='9001'`
        yield* connections.change("9001", "pause", actor)
        assert.include(
          (yield* Effect.flip(connections.change("9001", "resume", actor))).message,
          "Restore GitHub access",
        )
      }),
  )
  it.effect("binds expiring GitHub return state to the operator and consumes it once", () =>
    Effect.gen(function* () {
      const connections = yield* RepositoryConnections
      const url = new URL(yield* connections.github(null, actor))
      assert.strictEqual(url.pathname, "/apps/janitor/installations/new")
      const state = url.searchParams.get("state")!
      yield* Effect.flip(connections.returned(state, { ...actor, subject: "someone-else" }))
      yield* connections.returned(state, actor)
      yield* Effect.flip(connections.returned(state, actor))
      const expired = new URL(yield* connections.github(null, actor)).searchParams.get("state")!
      const sql = yield* SqlClient.SqlClient
      yield* sql`UPDATE repository_connection_attempt SET expires_at=now()-interval '1 minute' WHERE state::text=${expired}`
      yield* Effect.flip(connections.returned(expired, actor))
    }),
  )
  it.effect("discovers repositories immediately without dispatching sync or connecting them", () =>
    Effect.gen(function* () {
      const connections = yield* RepositoryConnections
      const sql = yield* SqlClient.SqlClient
      yield* sql`DELETE FROM github_repository WHERE repository_id = '9002'`
      const before = yield* sql`SELECT execution_key FROM workflow_outbox ORDER BY execution_key`
      yield* connections.refresh
      const repository = (yield* connections.inventory).repositories.find(
        (row) => row.repositoryId === "9002",
      )!
      assert.strictEqual(repository.owner, "new-org")
      assert.isFalse(repository.connected)
      assert.strictEqual(repository.access, "accessible")
      assert.deepStrictEqual(
        yield* sql`SELECT execution_key FROM workflow_outbox ORDER BY execution_key`,
        before,
      )
    }),
  )
  it.effect("waits for an active repository write before completing disconnect", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const connections = yield* RepositoryConnections
      yield* sql`UPDATE github_repository SET connected=TRUE,enabled=TRUE,access='accessible' WHERE repository_id='9001'`
      const locked = yield* Deferred.make<void>()
      yield* Effect.all(
        [
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`SELECT repository_id FROM github_repository WHERE repository_id='9001' FOR UPDATE`
              yield* Deferred.succeed(locked, undefined)
              yield* sql`SELECT pg_sleep(0.1)`
              yield* sql`INSERT INTO repository_connection_audit(repository_id,action,issuer,subject) VALUES('9001','write-ended','test','worker')`
            }),
          ),
          Deferred.await(locked).pipe(
            Effect.flatMap(() => connections.change("9001", "disconnect", actor)),
          ),
        ],
        { concurrency: 2 },
      )
      assert.deepStrictEqual(
        (yield* sql<{
          action: string
        }>`SELECT action FROM repository_connection_audit ORDER BY id DESC LIMIT 2`).map(
          (row) => row.action,
        ),
        [],
      )
    }),
  )
  it.effect("removes retained data and rejects old work across a fresh connection", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const connections = yield* RepositoryConnections
      const targets = yield* SyncTargets
      const journal = yield* GitHubWebhookJournal
      const cipher = yield* PayloadCipher
      yield* connections.change("9001", "connect", actor)
      const repositoryId = GitHubRepositoryDatabaseId.make("9001")
      const scope = { _tag: "Entity", repositoryId, number: 1 } as const
      const old = yield* targets.invalidate({ scope, sequence: Option.none() })
      yield* targets.begin(scope, old.generation)
      yield* sql`INSERT INTO labeling_policy(policy_id,repository_id,name,target,version) VALUES('old-p','9001','Old policy','issue',1)`
      yield* sql`INSERT INTO labeling_policy_version(version_id,policy_id,repository_id,revision,content_hash,program,manifest) VALUES('old-v','old-p','9001',1,${"a".repeat(64)},'{}','{}')`
      yield* sql`UPDATE labeling_policy SET published_version_id='old-v' WHERE policy_id='old-p'`
      yield* sql`INSERT INTO labeling_policy_draft(policy_id,program) VALUES('old-p','{}')`
      yield* sql`INSERT INTO labeling_policy_dependency(version_id,dependency_policy_id) VALUES('old-v','old-p')`
      yield* sql`INSERT INTO labeling_rule(rule_id,repository_id,label_id,policy_id,on_no_match,rule_group,version) VALUES('old-r','9001','label','old-p','no-action','Old group',1)`
      yield* sql`INSERT INTO labeling_configuration(repository_id,revision,rules,version_ids,required_tracks,preparation,actor_issuer,actor_subject) VALUES('9001',1,'[]','[]','[]','{}','test','test')`
      yield* sql`INSERT INTO labeling_repository_rules(repository_id,configured_revision,active_revision) VALUES('9001',1,1)`
      yield* sql`INSERT INTO labeling_audit(audit_id,repository_id,subject_kind,subject_id,actor_issuer,actor_subject,operation,after) VALUES('old-a','9001','rule','old-r','test','test','create','{}')`
      yield* sql`INSERT INTO labeling_reconciliation(repository_id,number,snapshot_generation,rules_revision,covered_sequence,fingerprint) VALUES('9001',1,1,1,1,${"a".repeat(64)})`
      yield* sql`INSERT INTO labeling_label_action(repository_id,number,snapshot_generation,rules_revision,label_id,action,rule_id) VALUES('9001',1,1,1,'label','add','old-r')`
      yield* sql`INSERT INTO labeling_rule_evaluation(repository_id,number,snapshot_generation,rules_revision,rule_id,policy_version_id,outcome,selected,reason,trace) VALUES('9001',1,1,1,'old-r','old-v','match',true,'matched','[]')`
      yield* sql`INSERT INTO labeling_rule_test(test_id,repository_id,request) VALUES('old-test','9001','{}')`
      yield* sql`INSERT INTO labeling_ai_consent(repository_id,state,provider,model,actor_issuer,actor_subject) VALUES('9001','enabled','test','test','test','test')`
      yield* sql`INSERT INTO labeling_ai_lease(lease_id,repository_id,expires_at) VALUES('old-lease','9001',now()+interval '1 hour')`
      yield* sql`INSERT INTO labeling_ai_claim(request_hash,owner,repository_id,expires_at) VALUES('old-claim','test','9001',now()+interval '1 hour')`
      yield* sql`INSERT INTO labeling_ai_decision(repository_id,policy_version_id,number,evidence_hash,provider,model,outcome,confidence,reason,latency_ms) VALUES('9001','old-v',1,${"a".repeat(64)},'test','test','match',1,'old reason',1)`
      yield* sql`INSERT INTO github_entity(repository_id,number,kind,title,body,author_login,state,github_updated_at,projected_sequence) VALUES('9001',1,'pull_request','Old title','Old body','test','open',now(),1)`
      yield* sql`INSERT INTO github_pull_request(repository_id,number,pull_request_id,pull_request_node_id,base_ref,draft,head_sha,merged) VALUES('9001',1,'1','node','main',false,'sha',false)`
      yield* sql`INSERT INTO github_entity_label(repository_id,number,label_id) VALUES('9001',1,'label')`
      yield* sql`INSERT INTO github_pull_request_collections(repository_id,number,files_complete) VALUES('9001',1,true)`
      yield* sql`INSERT INTO github_pull_request_file(repository_id,number,path,status) VALUES('9001',1,'secret.ts','modified')`
      yield* sql`INSERT INTO github_check_run(repository_id,number,name,state) VALUES('9001',1,'test','success')`
      yield* sql`INSERT INTO github_pull_request_review(repository_id,number,reviewer,state) VALUES('9001',1,'test','approved')`
      yield* sql`INSERT INTO github_label(repository_id,label_id,name,availability,projected_sequence) VALUES('9001','label','old label','available',1)`
      yield* sql`INSERT INTO github_http_cache(scope_key,request_key,repository_id,etag,encryption_key_id,encryption_iv,body) VALUES('installation:77','old','9001','etag','test',''::bytea,'data'::bytea)`
      yield* sql`INSERT INTO content_purge(subject_kind,subject_id,reason,due_at) VALUES('repository','9001','old',now())`
      const receivedAt = DateTime.nowUnsafe()
      const deliveryId = GitHubWebhookDeliveryId.make("legacy-disconnect")
      const encrypted = yield* cipher.encrypt(
        deliveryId,
        new TextEncoder().encode('{"repository":{"id":9001},"issue":{"body":"secret"}}'),
      )
      const entry = {
        deliveryId,
        eventName: GitHubWebhookName.make("issues"),
        receivedAt,
        payloadSha256: GitHubWebhookPayloadSha256.make("a".repeat(64)),
        encryption: encrypted.encryption,
        payload: encrypted.ciphertext,
      }
      // Exercise legacy attribution as well as already-accepted outbox cleanup.
      yield* journal.record(entry)
      yield* sql`UPDATE workflow_outbox SET accepted_at=now()`
      yield* connections.change("9001", "disconnect", actor)
      yield* connections.change("9001", "disconnect", actor)
      const tables = yield* sql<{
        table_name: string
      }>`SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='repository_id' AND table_name <> 'github_repository'`
      for (const { table_name } of tables)
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM ${sql(table_name)} WHERE repository_id='9001'`,
          [],
          table_name,
        )
      assert.deepStrictEqual(yield* sql`SELECT * FROM labeling_policy_draft`, [])
      assert.deepStrictEqual(yield* sql`SELECT * FROM labeling_policy_dependency`, [])
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM workflow_outbox WHERE payload->>'deliveryId'=${deliveryId} OR payload->'scope'->>'repositoryId'='9001'`,
        [],
      )
      assert.isFalse((yield* targets.invalidate({ scope, sequence: Option.none() })).dispatched)
      assert.isTrue(Option.isNone(yield* targets.get(scope)))
      yield* connections.change("9001", "connect", actor)
      const fresh = yield* targets.invalidate({ scope, sequence: Option.none() })
      assert.isTrue(BigInt(fresh.generation) > BigInt(old.generation))
      assert.strictEqual((yield* targets.begin(scope, old.generation))._tag, "Superseded")
      yield* targets.begin(scope, fresh.generation)
      assert.isTrue(
        Option.isNone(yield* targets.withRun(scope, old.generation, Effect.die("Stale write ran"))),
      )
      assert.isFalse(
        yield* targets.complete({
          scope,
          generation: old.generation,
          outcome: { _tag: "Verified", watermark: Option.none() },
        }),
      )
      yield* journal.record({ ...entry, repositoryId })
      assert.isTrue(Option.isNone(yield* journal.load(deliveryId)))
      let overflowPresent = true
      let acknowledged = false
      const envelope = yield* Schema.encodeEffect(GitHubWebhookEnvelopeV1)({
        schemaVersion: 1,
        deliveryId,
        eventName: entry.eventName,
        receivedAt,
        payloadSha256: entry.payloadSha256,
        encryption: entry.encryption,
        body: { _tag: "R2", key: GitHubWebhookR2ObjectKey.make("legacy-overflow") },
      })
      yield* handleMessage({
        id: "delayed-queue-message",
        attempts: 2,
        body: envelope,
        ack: () => {
          acknowledged = true
        },
        retry: () => assert.fail("Stale delivery retried"),
      }).pipe(
        Effect.provideService(GitHubPayloadReader, {
          get: () => Effect.succeedSome(entry.payload),
          delete: () =>
            Effect.sync(() => {
              overflowPresent = false
            }),
        }),
        Effect.provideService(GitHubEventsDeadLetter, {
          send: () => Effect.die("Stale delivery dead-lettered"),
        }),
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
      )
      assert.isTrue(acknowledged)
      assert.isFalse(overflowPresent)
      assert.isTrue(Option.isNone(yield* journal.load(deliveryId)))
      assert.strictEqual(
        (yield* connections.inventory).repositories.find((r) => r.repositoryId === repositoryId)!
          .syncState,
        "syncing",
      )
      yield* targets.complete({
        scope,
        generation: fresh.generation,
        outcome: { _tag: "Verified", watermark: Option.none() },
      })
      for (const track of ["labels", "entities", "pull_requests"] as const) {
        const trackScope = { _tag: "RepositoryTrack", repositoryId, track } as const
        const target = Option.getOrThrow(yield* targets.get(trackScope))
        yield* targets.begin(trackScope, target.requestedGeneration)
        yield* targets.complete({
          scope: trackScope,
          generation: target.requestedGeneration,
          outcome: { _tag: "Verified", watermark: Option.none() },
        })
      }
      const repository = (yield* connections.inventory).repositories.find(
        (r) => r.repositoryId === repositoryId,
      )!
      assert.strictEqual(repository.syncState, "ready")
      assert.strictEqual(repository.policyCount, 0)
      assert.strictEqual(repository.ruleCount, 0)
    }),
  )
})
