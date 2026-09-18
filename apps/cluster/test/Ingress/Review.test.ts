import { assert, describe, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import { ReviewRunId, type ReviewRun } from "@janitor/domain/Review/Run"
import { TeammateId } from "@janitor/domain/Team/Account"
import { CurrentAccessIdentity, CurrentTeammate } from "../../src/Ingress/Middleware.ts"
import { ReviewRoutesLayer } from "../../src/Ingress/Review.ts"
import { IssueReviewControl, ReviewForbidden, ReviewRunNotFound } from "../../src/Review/Control.ts"
import {
  IssueReviewSettings,
  ReviewRepositoryMissing,
  ReviewUnavailable,
} from "../../src/Review/Settings.ts"
import { IssueReviewStore } from "../../src/Review/Store.ts"

const at = DateTime.makeUnsafe("2026-09-17T12:00:00.000Z")
const identity = {
  issuer: "https://team.cloudflareaccess.test",
  subject: "user-1",
  email: undefined,
  expiresAt: at,
}
const teammate = {
  teammateId: TeammateId.make("11111111-1111-1111-1111-111111111111"),
  issuer: identity.issuer,
  subject: identity.subject,
  email: null,
  role: "member" as const,
  status: "active" as const,
  createdAt: at,
  removedAt: null,
}
const runId = ReviewRunId.make("22222222-2222-2222-2222-222222222222")
const run: ReviewRun = {
  runId,
  repositoryId: "701",
  issueNumber: 20,
  issueTitle: "Scheduler stalls",
  commentId: "1",
  invokerId: "9",
  invokerLogin: "octocat",
  instructions: "@janitor is this a regression?",
  dryRun: true,
  status: "running",
  queuePosition: 1,
  acceptedAt: at,
  startedAt: at,
  deadlineAt: DateTime.add(at, { minutes: 15 }),
  finishedAt: null,
  cancelReason: null,
  cancelledBy: null,
}

const settings: IssueReviewSettings["Service"] = {
  get: (repositoryId) =>
    repositoryId === "701"
      ? Effect.succeed({
          repositoryId,
          enabled: false,
          dryRun: true,
          available: true,
          updatedAt: null,
        })
      : Effect.fail(new ReviewRepositoryMissing({ repositoryId })),
  set: (repositoryId, request) =>
    request.dryRun
      ? Effect.succeed({ repositoryId, ...request, available: true, updatedAt: at })
      : Effect.fail(new ReviewUnavailable({ message: "Issue review is not available yet." })),
}

const store = {
  history: (repositoryId: string) => Effect.succeed(repositoryId === "701" ? [run] : []),
} as unknown as IssueReviewStore["Service"]

const cancelled: Array<string> = []
const control: IssueReviewControl["Service"] = {
  cancel: (_repositoryId, id, teammateId, reason) =>
    id === runId
      ? teammateId === teammate.teammateId
        ? Effect.sync(() => {
            cancelled.push(reason ?? "")
            return { runId, status: "cancelled" as const, cancelReason: reason ?? null }
          })
        : Effect.fail(new ReviewForbidden({ message: "Connect your GitHub account." }))
      : Effect.fail(new ReviewRunNotFound({ runId: id })),
}

const withHandler = <A, E, R>(
  use: (handler: (request: Request) => Promise<Response>) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => HttpRouter.toWebHandler(ReviewRoutesLayer, { disableLogger: true })),
    ({ handler }) =>
      use((request) =>
        handler(
          request,
          Context.make(IssueReviewSettings, settings).pipe(
            Context.add(IssueReviewStore, store),
            Context.add(IssueReviewControl, control),
            Context.add(CurrentAccessIdentity, identity),
            Context.add(CurrentTeammate, teammate),
          ),
        ),
      ),
    ({ dispose }) => Effect.promise(dispose),
  )

const request = (method: string, path: string, body?: unknown, site = "same-origin") =>
  new Request(`https://janitor.example${path}`, {
    method,
    headers: { "sec-fetch-site": site, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const base = "/repositories/701"

describe("ReviewRoutes", () => {
  it.effect("serves settings and history, and maps a missing repository to 404", () =>
    withHandler((handler) =>
      Effect.gen(function* () {
        const current = yield* Effect.promise(() => handler(request("GET", `${base}/issue-review`)))
        assert.strictEqual(current.status, 200)
        assert.deepStrictEqual(yield* Effect.promise(() => current.json()), {
          repositoryId: "701",
          enabled: false,
          dryRun: true,
          available: true,
          updatedAt: null,
        })
        const history = yield* Effect.promise(() => handler(request("GET", `${base}/reviews`)))
        assert.strictEqual(history.status, 200)
        const body = yield* Effect.promise(() => history.json())
        assert.strictEqual(body.runs[0].runId, runId)
        assert.strictEqual(body.runs[0].queuePosition, 1)
        assert.strictEqual(body.runs[0].deadlineAt, "2026-09-17T12:15:00.000Z")
        const missing = yield* Effect.promise(() =>
          handler(request("GET", "/repositories/702/issue-review")),
        )
        assert.strictEqual(missing.status, 404)
        const malformed = yield* Effect.promise(() =>
          handler(request("GET", "/repositories/x/reviews")),
        )
        assert.strictEqual(malformed.status, 400)
      }),
    ),
  )

  it.effect("changes settings and cancels runs behind same-origin writes", () =>
    withHandler((handler) =>
      Effect.gen(function* () {
        const enabled = yield* Effect.promise(() =>
          handler(request("PUT", `${base}/issue-review`, { enabled: true, dryRun: true })),
        )
        assert.strictEqual(enabled.status, 200)
        assert.strictEqual((yield* Effect.promise(() => enabled.json())).enabled, true)
        const unavailable = yield* Effect.promise(() =>
          handler(request("PUT", `${base}/issue-review`, { enabled: true, dryRun: false })),
        )
        assert.strictEqual(unavailable.status, 409)
        assert.strictEqual(
          (yield* Effect.promise(() => unavailable.json())).message,
          "Issue review is not available yet.",
        )
        const invalid = yield* Effect.promise(() =>
          handler(request("PUT", `${base}/issue-review`, { enabled: "yes" })),
        )
        assert.strictEqual(invalid.status, 400)

        const done = yield* Effect.promise(() =>
          handler(request("POST", `${base}/reviews/${runId}/cancel`, { reason: "Not needed" })),
        )
        assert.strictEqual(done.status, 200)
        assert.strictEqual((yield* Effect.promise(() => done.json())).status, "cancelled")
        assert.deepStrictEqual(cancelled, ["Not needed"])
        const unknown = yield* Effect.promise(() =>
          handler(request("POST", `${base}/reviews/other/cancel`, {})),
        )
        assert.strictEqual(unknown.status, 404)
        const crossOrigin = yield* Effect.promise(() =>
          handler(request("POST", `${base}/reviews/${runId}/cancel`, {}, "cross-site")),
        )
        assert.strictEqual(crossOrigin.status, 403)
        assert.lengthOf(cancelled, 1)
      }),
    ),
  )
})
