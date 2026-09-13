import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { RepositoryAccess } from "../../src/Agent/RepositoryAccess.ts"
import { AgentSessions } from "../../src/Agent/Sessions.ts"
import { GitHubFeedbackHttpLayer } from "../../src/GitHub/FeedbackHttp.ts"
import { GitHubCommentApi } from "../../src/GitHub/FeedbackDelivery.ts"
import { GitHubAppAuth } from "../../src/GitHub/AppAuth.ts"
import { agentLayers, fakeRunnerLayer, FakeRunner } from "../Agent/support.ts"

let body: unknown = []
let status = 200
let link = ""
let verifiedAppId = "6"
const base = "https://api.github.com/repos/team/repo"
const http = HttpClient.make((request) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      new Response(
        JSON.stringify(
          request.url.endsWith("/app")
            ? { id: verifiedAppId, slug: "janitor" }
            : request.url.includes("/users/")
              ? { id: "50", login: "janitor[bot]", type: "Bot" }
              : body,
        ),
        { status, headers: { link } },
      ),
    ),
  ),
)
const services = GitHubFeedbackHttpLayer.pipe(
  Layer.provide(
    Layer.succeed(GitHubAppAuth, {
      appJwt: Effect.succeed(Redacted.make("app-jwt")),
      installationToken: () => Effect.succeed(Redacted.make("scoped")),
      invalidateInstallationToken: () => Effect.void,
    }),
  ),
  Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
  Layer.provide(
    Layer.succeed(RepositoryAccess, {
      authorize: () =>
        Effect.succeed({
          owner: "team",
          repo: "repo",
          pullRequestNumber: 7,
          appId: "5",
          token: Redacted.make("scoped"),
        }),
    }),
  ),
  Layer.provideMerge(agentLayers(fakeRunnerLayer(new FakeRunner()))),
)
layer(services, { timeout: "3 minutes" })("GitHub feedback HTTP", (it) => {
  it.effect("reconciles only the App marker at the exact PR and inline parent across pages", () =>
    Effect.gen(function* () {
      yield* (yield* AgentSessions).start({
        sessionId: "http-feedback",
        title: "Review",
        repositoryId: "12345",
      })
      const api = yield* GitHubCommentApi
      const valid = {
        id: "900",
        body: "Done\n<!-- janitor-feedback:marker -->",
        user: { type: "Bot" },
        performed_via_github_app: { id: "5" },
        pull_request_url: `${base}/pulls/7`,
        in_reply_to_id: "101",
      }
      body = [
        { ...valid, performed_via_github_app: { id: "6" } },
        { ...valid, in_reply_to_id: "102" },
        { ...valid, pull_request_url: `${base}/pulls/8` },
      ]
      link = `<${base}/pulls/7/comments?page=2>; rel="next"`
      const first = yield* api.reconcile("http-feedback", "101", "marker", "")
      assert.isNull(first.id)
      body = [valid]
      link = ""
      assert.strictEqual(
        (yield* api.reconcile("http-feedback", "101", "marker", first.next)).id,
        "900",
      )
      assert.strictEqual(
        (yield* api
          .reconcile("http-feedback", "101", "marker", "https://attacker.test/comments")
          .pipe(Effect.result))._tag,
        "Failure",
      )
      body = []
      assert.isNull((yield* api.reconcile("http-feedback", "101", "marker", "")).id)
    }),
  )
  it.effect("verifies the numeric App bot identity when review comments omit App metadata", () =>
    Effect.gen(function* () {
      const api = yield* GitHubCommentApi
      status = 200
      const comment = {
        id: "910",
        body: "<!-- janitor-feedback:marker -->",
        user: { id: "50", type: "Bot" },
        pull_request_url: `${base}/pulls/7`,
        in_reply_to_id: "101",
      }
      body = [{ ...comment, user: { id: "42", type: "User" } }, comment]
      assert.strictEqual(
        (yield* api.reconcile("http-feedback", "101", "marker", "").pipe(Effect.result))._tag,
        "Failure",
      )
      verifiedAppId = "5"
      assert.strictEqual((yield* api.reconcile("http-feedback", "101", "marker", "")).id, "910")
      body = [{ ...comment, user: { id: "51", type: "Bot" } }]
      assert.isNull((yield* api.reconcile("http-feedback", "101", "marker", "")).id)
    }),
  )
  it.effect(
    "reports a deleted inline target and treats malformed successful writes as uncertain",
    () =>
      Effect.gen(function* () {
        const api = yield* GitHubCommentApi
        status = 404
        const missing = yield* api
          .post("http-feedback", "101", "Done", "marker")
          .pipe(Effect.result)
        assert.strictEqual(missing._tag, "Failure")
        if (missing._tag === "Failure") assert.strictEqual(missing.failure.disposition, "missing")
        status = 201
        body = {}
        const lost = yield* api.post("http-feedback", null, "Done", "marker").pipe(Effect.result)
        assert.strictEqual(lost._tag, "Failure")
        if (lost._tag === "Failure") assert.strictEqual(lost.failure.disposition, "uncertain")
      }),
  )
})
