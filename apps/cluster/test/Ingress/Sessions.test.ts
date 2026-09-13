import { assert, it } from "@effect/vitest"
import { TeammateId } from "@janitor/domain/Team/Account"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import { SessionObservation } from "../../src/Agent/Observation.ts"
import { AgentSessionNotFound } from "../../src/Agent/Sessions.ts"
import { CurrentAccessIdentity, CurrentTeammate } from "../../src/Ingress/Middleware.ts"
import { SessionRoutesLayer } from "../../src/Ingress/Sessions.ts"
import { LiveUpdates } from "../../src/LiveUpdates.ts"

const at = DateTime.makeUnsafe("2026-09-13T10:00:00.000Z")
const summary = {
  sessionId: "ses-1",
  title: "Fix the flaky test",
  repository: { repositoryId: "901", owner: "acme", repo: "widgets" },
  homeThread: { platform: "slack" as const, url: "https://app.slack.com/archives/C1/p1" },
  pullRequests: [{ number: 17, url: "https://github.com/acme/widgets/pull/17" }],
  execution: "working" as const,
  reason: null,
  activityAt: at,
  usage: null,
  deliveryWarning: null,
  freshness: { readAt: at, error: null },
}

it.effect("serves paginated session reads and the team-wide live channel to the teammate", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => HttpRouter.toWebHandler(SessionRoutesLayer, { disableLogger: true })),
    ({ handler }) =>
      Effect.gen(function* () {
        const expiresAt = Date.now() + 60000
        const listed: Array<unknown> = []
        const connections: Array<[string, number]> = []
        const context = Context.make(CurrentAccessIdentity, {
          issuer: "https://access.example",
          subject: "person",
          email: undefined,
          expiresAt: DateTime.makeUnsafe(expiresAt),
        }).pipe(
          Context.add(CurrentTeammate, {
            teammateId: TeammateId.make("t-1"),
            issuer: "https://access.example",
            subject: "person",
            email: null,
            role: "member",
            status: "active",
            createdAt: at,
            removedAt: null,
          }),
          Context.add(LiveUpdates, {
            flush: Effect.void,
            connect: () => Effect.succeed(new Response(null, { status: 500 })),
            connectSessions: (teammateId, expiry) =>
              Effect.sync(() => {
                connections.push([teammateId, expiry])
                return new Response(null, { status: 204 })
              }),
          }),
          Context.add(SessionObservation, {
            list: (request) =>
              Effect.sync(() => {
                listed.push(request)
                return { sessions: [summary], cursor: null }
              }),
            detail: (sessionId) =>
              sessionId === "ses-1"
                ? Effect.succeed({
                    ...summary,
                    pendingInputs: 1,
                    acceptedInputs: 3,
                    lastInputAt: at,
                    latestError: null,
                    pendingDelivery: [],
                    recovery: [],
                  })
                : Effect.fail(new AgentSessionNotFound({ sessionId })),
          }),
        )
        const get = (path: string, headers: Record<string, string> = {}) =>
          Effect.promise(() =>
            handler(new Request(`https://janitor.example${path}`, { headers }), context),
          )

        const page = yield* get(
          `/sessions?limit=5&cursor=${encodeURIComponent(JSON.stringify({ working: false, activityAt: "2026-09-13 09:00:00+00", sessionId: "ses-0" }))}`,
        )
        assert.strictEqual(page.status, 200)
        const body = yield* Effect.promise(() => page.json())
        assert.deepStrictEqual(listed, [
          {
            cursor: { working: false, activityAt: "2026-09-13 09:00:00+00", sessionId: "ses-0" },
            limit: 5,
          },
        ])
        assert.strictEqual(body.sessions[0].title, "Fix the flaky test")
        assert.strictEqual(body.sessions[0].activityAt, "2026-09-13T10:00:00.000Z")

        assert.strictEqual((yield* get("/sessions?cursor=nonsense")).status, 400)

        const detail = yield* get("/sessions/ses-1")
        assert.strictEqual(detail.status, 200)
        const detailBody = yield* Effect.promise(() => detail.json())
        assert.strictEqual(detailBody.pendingInputs, 1)
        assert.strictEqual((yield* get("/sessions/missing")).status, 404)

        // The live channel is bound to the teammate and the Access session, same-origin only.
        assert.strictEqual(
          (yield* get("/sessions/live", {
            origin: "https://elsewhere.example",
            upgrade: "websocket",
          })).status,
          403,
        )
        assert.strictEqual(
          (yield* get("/sessions/live", { origin: "https://janitor.example" })).status,
          204,
        )
        assert.strictEqual(
          (yield* get("/sessions/live", {
            origin: "https://janitor.example",
            upgrade: "websocket",
          })).status,
          204,
        )
        assert.deepStrictEqual(connections, [
          ["t-1", 0],
          ["t-1", expiresAt],
        ])
      }),
    ({ dispose }) => Effect.promise(dispose),
  ),
)
