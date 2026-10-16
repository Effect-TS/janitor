import { assert, layer } from "@effect/vitest"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/http/HttpRouter"
import * as SqlClient from "effect/sql/SqlClient"
import { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { RunId } from "@janitor/domain/PullRequestReview/Run"
import { GitHubReadModel } from "../../src/GitHub/ReadModel.ts"
import { CurrentAccessIdentity } from "../../src/Ingress/Middleware.ts"
import { PullRequestReviewRoutesLayer } from "../../src/Ingress/PullRequestReview.ts"
import { RepositoryDisabler } from "../../src/PullRequestReview/Scheduler.ts"
import { PullRequestReviewStore } from "../../src/PullRequestReview/Store.ts"
import { MigratedPostgresLayer } from "../support/Postgres.ts"

const publicRepositoryId = GitHubRepositoryDatabaseId.make("9400")
const privateRepositoryId = GitHubRepositoryDatabaseId.make("9401")
/** A repository whose visibility no inventory or event has stated yet. */
const unseenRepositoryId = GitHubRepositoryDatabaseId.make("9402")
const listedRepositoryId = GitHubRepositoryDatabaseId.make("9403")
const unknownRepositoryId = GitHubRepositoryDatabaseId.make("9499")

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO github_installation(access_error,installation_id,account_database_id,account_handle,account_type,repository_selection,status,html_url,projected_sequence) VALUES(NULL,'77','1','test','Organization','selected','active','https://github.com/settings/installations/77',1) ON CONFLICT DO NOTHING`
  yield* sql`INSERT INTO github_repository(repository_id,installation_id,owner,repo,is_private,connected,enabled,access,projected_sequence) VALUES(${publicRepositoryId},'77','test','public',FALSE,TRUE,TRUE,'accessible',1),(${privateRepositoryId},'77','test','private',TRUE,TRUE,TRUE,'accessible',1),(${unseenRepositoryId},'77','test','unseen',NULL,TRUE,TRUE,'accessible',1),(${listedRepositoryId},'77','test','listed',FALSE,TRUE,TRUE,'accessible',1) ON CONFLICT DO NOTHING`
})

const identity = {
  issuer: "https://team.cloudflareaccess.test",
  subject: "user-1",
  email: undefined,
  expiresAt: DateTime.makeUnsafe("2026-10-14T12:00:00.000Z"),
}

/** The deployment's environment; PR review is available while the API key is set. */
const withKey = { PR_REVIEW_OPENROUTER_API_KEY: "test-key" }

/** The repositories the disable operation was called for, in order. */
const disabled: Array<GitHubRepositoryDatabaseId> = []

const withHandler = <A, E, R>(
  env: Record<string, string>,
  use: (handler: (request: Request) => Promise<Response>) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    yield* seed
    const services = yield* Effect.context<
      PullRequestReviewStore | GitHubReadModel | SqlClient.SqlClient
    >()
    const store = Context.get(services, PullRequestReviewStore)
    // Like the real operation it turns the flag off; it cancels nothing here.
    const disabler = RepositoryDisabler.of({
      disable: (repositoryId) =>
        Effect.sync(() => disabled.push(repositoryId)).pipe(
          Effect.andThen(store.setEnabled(repositoryId, false)),
        ),
    })
    return yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(PullRequestReviewRoutesLayer, { disableLogger: true }),
      ),
      ({ handler }) =>
        use((request) =>
          handler(
            request,
            services.pipe(
              Context.add(RepositoryDisabler, disabler),
              Context.add(CurrentAccessIdentity, identity),
              Context.add(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
            ),
          ),
        ),
      ({ dispose }) => Effect.promise(dispose),
    )
  })

const request = (method: string, path: string, body?: unknown, site = "same-origin") =>
  new Request(`https://janitor.example${path}`, {
    method,
    headers: { "sec-fetch-site": site, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const settings = (repositoryId: GitHubRepositoryDatabaseId) =>
  `/repositories/${repositoryId}/pull-request-review`

const send = (handler: (request: Request) => Promise<Response>, request: Request) =>
  Effect.promise(async () => {
    const response = await handler(request)
    // Rejections such as the same-origin 403 answer in plain text.
    const json = response.headers.get("content-type")?.startsWith("application/json")
    return { status: response.status, body: json ? await response.json() : undefined }
  })

const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, 14, 12, minute))

const started = (minute: number) => ({
  runId: RunId.make(crypto.randomUUID()),
  repositoryId: listedRepositoryId,
  number: 100 + minute,
  title: `Change ${minute}`,
  headSha: `${minute}`.padStart(40, "a"),
  baseSha: "b".repeat(40),
  trigger: { _tag: "Automatic" } as const,
  startedAt: at(minute),
})

const Services = Layer.mergeAll(PullRequestReviewStore.layer, GitHubReadModel.layer).pipe(
  Layer.provideMerge(MigratedPostgresLayer),
)

layer(Services, { timeout: "2 minutes" })("PullRequestReviewRoutes", (it) => {
  it.effect("reports the deployment status, and the flag is off until enabled", () =>
    Effect.gen(function* () {
      yield* withHandler(withKey, (handler) =>
        Effect.gen(function* () {
          assert.deepStrictEqual(
            yield* send(handler, request("GET", settings(publicRepositoryId))),
            {
              status: 200,
              body: {
                repositoryId: publicRepositoryId,
                enabled: false,
                deployment: {
                  available: true,
                  model: "openai/gpt-6.1-sol",
                  reasoningEffort: "medium",
                },
              },
            },
          )
          const enabled = yield* send(
            handler,
            request("PUT", settings(publicRepositoryId), { enabled: true }),
          )
          assert.strictEqual(enabled.status, 200)
          assert.isTrue(enabled.body.enabled)
          assert.isTrue(
            (yield* send(handler, request("GET", settings(publicRepositoryId)))).body.enabled,
          )
        }),
      )
      yield* withHandler({ PR_REVIEW_AI_REASONING_EFFORT: "high" }, (handler) =>
        Effect.gen(function* () {
          assert.deepStrictEqual(
            (yield* send(handler, request("GET", settings(publicRepositoryId)))).body.deployment,
            { available: false, model: "openai/gpt-6.1-sol", reasoningEffort: "high" },
          )
        }),
      )
    }),
  )

  it.effect("refuses cross-site writes, unknown repositories and private repositories", () =>
    withHandler(withKey, (handler) =>
      Effect.gen(function* () {
        const crossSite = yield* send(
          handler,
          request("PUT", settings(listedRepositoryId), { enabled: true }, "cross-site"),
        )
        assert.strictEqual(crossSite.status, 403)
        assert.strictEqual(
          (yield* send(handler, request("GET", settings(unknownRepositoryId)))).status,
          404,
        )
        assert.strictEqual(
          (yield* send(handler, request("PUT", settings(unknownRepositoryId), { enabled: true })))
            .status,
          404,
        )
        for (const repositoryId of [privateRepositoryId, unseenRepositoryId]) {
          const refused = yield* send(
            handler,
            request("PUT", settings(repositoryId), { enabled: true }),
          )
          assert.strictEqual(refused.status, 409)
          assert.isString(refused.body.message)
          assert.isFalse(
            (yield* send(handler, request("GET", settings(repositoryId)))).body.enabled,
          )
        }
        assert.isFalse(
          (yield* send(handler, request("GET", settings(listedRepositoryId)))).body.enabled,
        )
      }),
    ),
  )

  it.effect("disabling goes through the disable operation", () =>
    withHandler(withKey, (handler) =>
      Effect.gen(function* () {
        yield* send(handler, request("PUT", settings(publicRepositoryId), { enabled: true }))
        disabled.length = 0
        const off = yield* send(
          handler,
          request("PUT", settings(publicRepositoryId), { enabled: false }),
        )
        assert.strictEqual(off.status, 200)
        assert.isFalse(off.body.enabled)
        assert.deepStrictEqual(disabled, [publicRepositoryId])
      }),
    ),
  )

  it.effect("lists runs newest first a page at a time, with counts and skip reasons", () =>
    withHandler(withKey, (handler) =>
      Effect.gen(function* () {
        const store = yield* PullRequestReviewStore
        // One more run than the page size, as on Activity.
        const runs = Array.from({ length: 51 }, (_, minute) => started(minute))
        for (const run of runs.slice(0, 49)) yield* store.start(run)
        const reviewed = runs[49]!
        yield* store.finish({
          ...reviewed,
          trigger: { _tag: "Rerun", invoker: "octocat", commentId: "42" },
          status: "changes_requested",
          verdict: "request_changes",
          failedGates: ["sensitive_path"],
          standardsSources: {},
          resumeCount: 0,
          errorCategory: null,
          finishedAt: at(55),
          review: {
            id: "501",
            url: "https://github.com/test/listed/pull/149#pullrequestreview-501",
          },
          checkRun: { id: "601", url: "https://github.com/test/listed/runs/601" },
        })
        yield* store.addFindings(reviewed.runId, [
          ...[
            ["blocking", "new"],
            ["blocking", "addressed"],
            ["nit", "carried_over"],
            ["nit", "new"],
          ].map(([severity, outcome], line) => ({
            path: "src/index.ts",
            startLine: line + 1,
            endLine: line + 1,
            severity: severity as "blocking" | "nit",
            comment: "A finding",
            fingerprint: `fp-${line}`,
            outcome: outcome as "new" | "addressed" | "carried_over",
          })),
        ])
        const skipped = runs[50]!
        yield* store.skip({ ...skipped, reason: "oversized" })

        const runsPath = `${settings(listedRepositoryId)}/runs`
        const first = yield* send(handler, request("GET", runsPath))
        assert.strictEqual(first.status, 200)
        assert.lengthOf(first.body.runs, 50)
        assert.deepStrictEqual(
          first.body.runs.map((run: { runId: string }) => run.runId),
          runs
            .slice(1)
            .reverse()
            .map((run) => run.runId),
        )
        assert.deepInclude(first.body.runs[0], {
          number: skipped.number,
          headSha: skipped.headSha,
          status: "skipped",
          reason: "oversized",
          trigger: { _tag: "Automatic" },
        })
        assert.deepInclude(first.body.runs[1], {
          number: reviewed.number,
          title: reviewed.title,
          status: "changes_requested",
          trigger: { _tag: "Rerun", invoker: "octocat", commentId: "42" },
          failedGates: ["sensitive_path"],
          blockers: 1,
          nits: 2,
          review: {
            id: "501",
            url: "https://github.com/test/listed/pull/149#pullrequestreview-501",
          },
          checkRun: { id: "601", url: "https://github.com/test/listed/runs/601" },
        })
        assert.isString(first.body.runs[1].finishedAt)
        assert.deepInclude(first.body.runs[2], { status: "running", finishedAt: null })

        const second = yield* send(
          handler,
          request("GET", `${runsPath}?cursor=${first.body.cursor}`),
        )
        assert.deepStrictEqual(
          second.body.runs.map((run: { runId: string }) => run.runId),
          [runs[0]!.runId],
        )
        assert.isNull(second.body.cursor)

        assert.strictEqual(
          (yield* send(handler, request("GET", `${runsPath}?cursor=invalid`))).status,
          400,
        )
      }),
    ),
  )
})
