import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as DateTime from "effect/DateTime"
import * as Schema from "effect/Schema"
import { GitHubWebhookEvent } from "@janitor/domain/GitHub/WebhookEvent"
import { GitHubWebhookDeliveryId } from "@janitor/domain/GitHub/Id"
import {
  GitHubWebhookName,
  GitHubWebhookPayloadSha256,
} from "@janitor/domain/GitHub/WebhookEnvelope"
import { GitHubWebhookJournal } from "../src/GitHub/WebhookJournal.ts"
import { PayloadCipher } from "../src/PayloadCipher.ts"
import { ContentPurge } from "../src/ContentPurge.ts"
import { applyEvent } from "../src/GitHub/ProjectWebhook.ts"
import { Policies } from "../src/Labeling/Policies.ts"
import { SyncTargets } from "../src/SyncTargets.ts"
import { SyncPlanner } from "../src/SyncPlanner.ts"
import { RepositoryActivity } from "../src/RepositoryActivity.ts"
import { RepositoryConnections } from "../src/RepositoryConnections.ts"
import { GitHubTransport } from "../src/GitHub/Transport.ts"
import { TestPayloadCipher } from "./support/PayloadCipher.ts"
import { Services, actor, baseMain, repositoryId, webhookNow } from "./Labeling/support.ts"

const permissions = { metadata: "read", issues: "write", pull_requests: "read", checks: "read" }
let granted = { ...permissions }
let listingDenied = false
let suspendedAt: string | null = null
let installed = true
let installationId = 77
let fullName = "effect/one"
let isPrivate = true
const installation = () => ({
  id: installationId,
  account: { id: 1, login: "effect", type: "Organization" },
  repository_selection: "all",
  html_url: "https://github.com/settings/installations/77",
  suspended_at: suspendedAt,
  permissions: granted,
})
const services = Layer.mergeAll(
  RepositoryConnections.layer,
  SyncPlanner.layer,
  RepositoryActivity.layer,
  GitHubWebhookJournal.layer,
  ContentPurge.layer,
).pipe(
  Layer.provideMerge(TestPayloadCipher),
  Layer.provideMerge(Services),
  Layer.provide(
    Layer.succeed(GitHubTransport, {
      request: (request) =>
        Effect.succeed({
          _tag: "Ok" as const,
          status: 200,
          body: request.url.startsWith("/app/installations?")
            ? installed
              ? [installation()]
              : []
            : request.url.startsWith("/app/installations/")
              ? installation()
              : request.url.startsWith("/installation/repositories")
                ? listingDenied
                  ? {}
                  : {
                      total_count: 1,
                      repositories: [{ id: 701, full_name: fullName, private: isPrivate }],
                    }
                : { id: 701 },
          etag: Option.none(),
          link: Option.none(),
          requestId: Option.none(),
        }),
    }),
  ),
)

layer(services, { timeout: "2 minutes" })("GitHub access", (it) => {
  it.effect("records permission loss even when repository listing is no longer available", () =>
    Effect.gen(function* () {
      const connections = yield* RepositoryConnections
      yield* connections.refresh
      assert.isFalse((yield* connections.inventory).repositories[0]!.connected)
      granted = { ...permissions, issues: "read" }
      const denied = yield* Effect.flip(connections.change("701", "connect", actor))
      assert.include(denied.message, "issues: write")
      listingDenied = true
      yield* connections.refresh.pipe(Effect.ignore)
      const unavailable = (yield* connections.inventory).repositories[0]!
      assert.strictEqual(unavailable.syncState, "access-unavailable")
      assert.include(unavailable.accessError!, "issues: write")
    }),
  )
  it.effect(
    "retains configuration, fences old work, and synchronizes after access restoration",
    () =>
      Effect.gen(function* () {
        const connections = yield* RepositoryConnections
        const targets = yield* SyncTargets
        const planner = yield* SyncPlanner
        const activity = yield* RepositoryActivity
        granted = { ...permissions }
        listingDenied = false
        yield* connections.refresh
        yield* connections.change("701", "connect", actor)
        yield* (yield* Policies).create(
          repositoryId,
          { name: "Retained", description: "", source: baseMain },
          actor,
        )
        const state = connections.inventory.pipe(
          Effect.map((inventory) => inventory.repositories[0]!),
        )
        const synchronize = Effect.gen(function* () {
          for (const track of ["labels", "entities", "pull_requests"] as const) {
            const scope = { _tag: "RepositoryTrack", repositoryId, track } as const
            const previous = yield* targets.get(scope)
            if (
              Option.isNone(previous) ||
              previous.value.requestedGeneration === previous.value.completedGeneration
            )
              yield* targets.invalidate({ scope, sequence: Option.none(), full: true })
            const target = Option.getOrThrow(yield* targets.get(scope))
            const begun = yield* targets.begin(scope, target.dispatchedGeneration)
            assert.strictEqual(begun._tag, "Run")
            if (begun._tag === "Run")
              yield* targets.complete({
                scope,
                generation: begun.generation,
                outcome: { _tag: "Verified", watermark: Option.none() },
              })
          }
        })
        yield* synchronize
        assert.strictEqual((yield* state).syncState, "ready")
        for (const visibility of [true, false]) {
          isPrivate = visibility
          for (const loss of ["issues", "checks", "suspend", "uninstall"] as const) {
            const scope = { _tag: "Entity", repositoryId, number: 5 } as const
            const old = yield* targets.invalidate({
              scope,
              sequence: Option.none(),
              webhookReceivedAt: yield* webhookNow,
            })
            yield* targets.begin(scope, old.generation)
            if (loss === "checks")
              yield* targets.complete({
                scope,
                generation: old.generation,
                outcome: { _tag: "Failed", error: "GitHub request timed out before access loss" },
              })
            if (loss === "issues") granted = { ...permissions, issues: "read" }
            if (loss === "checks") granted = { ...permissions, checks: "none" }
            if (loss === "suspend") suspendedAt = new Date().toISOString()
            if (loss === "uninstall") installed = false
            yield* connections.refresh
            assert.strictEqual((yield* state).syncState, "access-unavailable")
            assert.strictEqual((yield* state).policyCount, 1)
            assert.isTrue(
              Option.isNone(yield* activity.run(repositoryId, Effect.die("Unavailable work ran"))),
            )
            assert.isFalse(
              (yield* targets.invalidate({ scope, sequence: Option.none() })).dispatched,
            )
            const staleEvent = new Date()
            granted = { ...permissions }
            suspendedAt = null
            installed = true
            yield* connections.refresh
            assert.strictEqual((yield* state).syncState, loss === "checks" ? "failed" : "syncing")
            assert.strictEqual((yield* targets.begin(scope, old.generation))._tag, "Superseded")
            assert.isTrue(
              Option.isNone(
                yield* activity.run(repositoryId, Effect.die("Old event replayed"), staleEvent),
              ),
            )
            // Recovery scheduling is the same public interface used by the worker.
            if (loss === "checks") {
              assert.isAbove(yield* targets.retryDue, 0)
              const target = Option.getOrThrow(yield* targets.get(scope))
              const begun = yield* targets.begin(scope, target.dispatchedGeneration)
              assert.strictEqual(begun._tag, "Run")
              if (begun._tag === "Run")
                yield* targets.complete({
                  scope,
                  generation: begun.generation,
                  outcome: { _tag: "Verified", watermark: Option.none() },
                })
            }
            yield* planner.plan(DateTime.makeUnsafe(Date.now() + 60 * 60 * 1000))
            yield* synchronize
            assert.strictEqual((yield* state).syncState, "ready")
            assert.strictEqual((yield* state).policyCount, 1)
          }
        }
        yield* connections.change("701", "pause", actor)
        granted = { ...permissions, checks: "none" }
        yield* connections.refresh
        granted = { ...permissions }
        yield* connections.refresh
        assert.strictEqual((yield* state).syncState, "paused")
        assert.isFalse((yield* state).enabled)
        fullName = "effect/renamed"
        yield* connections.refresh
        assert.strictEqual((yield* state).repo, "renamed")
        assert.strictEqual((yield* state).policyCount, 1)
        installationId = 88
        fullName = "new-owner/renamed"
        granted = { ...permissions, issues: "read" }
        yield* connections.refresh
        assert.strictEqual((yield* state).syncState, "access-unavailable")
        granted = { ...permissions }
        yield* connections.refresh
        assert.strictEqual((yield* state).owner, "new-owner")
        assert.strictEqual((yield* state).installationId, "88")
        assert.strictEqual((yield* state).syncState, "paused")
        assert.strictEqual((yield* state).policyCount, 1)
        yield* connections.change("701", "resume", actor)
        assert.strictEqual((yield* state).syncState, "syncing")
        yield* synchronize
        assert.strictEqual((yield* state).syncState, "ready")
        const repositoryEvent = (action: "renamed" | "transferred", name: string) =>
          Effect.gen(function* () {
            const deliveryId = GitHubWebhookDeliveryId.make(crypto.randomUUID())
            const raw = {
              id: deliveryId,
              name: "repository",
              payload: {
                action,
                repository: { id: 701, full_name: name, private: isPrivate },
              },
            }
            const event = yield* Schema.decodeUnknownEffect(GitHubWebhookEvent)(raw)
            const encrypted = yield* (yield* PayloadCipher).encrypt(
              deliveryId,
              new TextEncoder().encode(JSON.stringify(raw.payload)),
            )
            const entry = yield* (yield* GitHubWebhookJournal).record({
              deliveryId,
              repositoryId,
              eventName: GitHubWebhookName.make("repository"),
              receivedAt: DateTime.nowUnsafe(),
              payloadSha256: GitHubWebhookPayloadSha256.make("a".repeat(64)),
              encryption: encrypted.encryption,
              payload: encrypted.ciphertext,
            })
            yield* applyEvent(event, entry.sequence)
          })
        yield* repositoryEvent("renamed", "new-owner/webhook-name")
        assert.strictEqual((yield* state).repo, "webhook-name")
        assert.strictEqual((yield* state).syncState, "ready")
        yield* repositoryEvent("transferred", "third-owner/webhook-name")
        assert.strictEqual((yield* state).owner, "third-owner")
        assert.strictEqual((yield* state).syncState, "access-unavailable")
        assert.strictEqual((yield* state).policyCount, 1)
        installationId = 99
        fullName = "third-owner/webhook-name"
        yield* connections.refresh
        assert.strictEqual((yield* state).installationId, "99")
        assert.strictEqual((yield* state).syncState, "syncing")
        yield* synchronize
        assert.strictEqual((yield* state).syncState, "ready")
      }),
  )
})
