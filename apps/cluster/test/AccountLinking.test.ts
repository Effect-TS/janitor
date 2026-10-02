import { assert, layer } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as SqlClient from "effect/sql/SqlClient"
import * as HttpClient from "effect/http/HttpClient"
import type * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { AccountLinking, AccountLinkingConfig } from "../src/AccountLinking.ts"
import * as GitHubLink from "../src/Linking/GitHub.ts"
import { Teammates } from "../src/Teammates.ts"
import { MigratedPostgresLayer } from "./support/Postgres.ts"

const ISSUER = "https://team.cloudflareaccess.test"
const GITHUB_CLIENT_ID = "github-client"
const ORIGIN = "https://janitor.test"

/** The requests the fake GitHub saw, in order. */
interface Platforms {
  seen: Array<string>
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  })

const fakePlatforms = (platforms: Platforms) =>
  HttpClient.make((request) =>
    Effect.gen(function* () {
      platforms.seen.push(`${request.method} ${request.url}`)
      if (request.url === GitHubLink.GITHUB_TOKEN_URL) {
        const form = new URLSearchParams(yield* bodyText(request))
        return HttpClientResponse.fromWeb(
          request,
          form.get("code") === "github-code"
            ? json({ access_token: "user-token", token_type: "bearer" })
            : json({ error: "bad_verification_code" }),
        )
      }
      if (request.url === GitHubLink.GITHUB_USER_URL) {
        return HttpClientResponse.fromWeb(
          request,
          request.headers.authorization === "Bearer user-token"
            ? json({ id: 4242, login: "octocat" })
            : json({ message: "Bad credentials" }, 401),
        )
      }
      return HttpClientResponse.fromWeb(request, new Response("not found", { status: 404 }))
    }),
  )

/** The form bodies the exchanges send; anything else reads as empty. */
const bodyText = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.sync(() =>
    request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
  )

const config = (platforms: Platforms) =>
  Layer.succeed(AccountLinkingConfig, {
    github: Option.some({
      clientId: GITHUB_CLIENT_ID,
      clientSecret: Redacted.make("github-secret"),
      redirectUri: `${ORIGIN}/account/github/return`,
    }),
  }).pipe(Layer.merge(Layer.succeed(HttpClient.HttpClient, fakePlatforms(platforms))))

class TestPlatforms extends Context.Service<TestPlatforms, Platforms>()("TestPlatforms") {}

const Services = AccountLinking.layer.pipe(
  Layer.provide(Layer.unwrap(Effect.map(TestPlatforms, config))),
  Layer.provideMerge(Layer.sync(TestPlatforms, (): Platforms => ({ seen: [] }))),
  Layer.provideMerge(Teammates.layer),
  Layer.provideMerge(MigratedPostgresLayer),
)

const founder = { issuer: ISSUER, subject: "founder", email: "founder@example.com" }
const second = { issuer: ISSUER, subject: "second", email: undefined }

const admitted = (identity: { issuer: string; subject: string; email: string | undefined }) =>
  Effect.flatMap(Teammates, (teammates) => teammates.admit(identity))

layer(Services, { timeout: "2 minutes" })("Account linking", (it) => {
  it.effect("proves a GitHub account by numeric user lookup with a one-time token", () =>
    Effect.gen(function* () {
      const linking = yield* AccountLinking
      const platforms = yield* TestPlatforms
      const admin = yield* admitted(founder)
      const other = yield* admitted(second)
      const url = new URL(yield* linking.start(admin.teammateId, "github"))
      assert.strictEqual(url.origin + url.pathname, GitHubLink.GITHUB_AUTHORIZE_URL)
      assert.strictEqual(url.searchParams.get("client_id"), GITHUB_CLIENT_ID)
      assert.strictEqual(url.searchParams.get("redirect_uri"), `${ORIGIN}/account/github/return`)
      const state = url.searchParams.get("state")!
      // The attempt belongs to the teammate who started it.
      const foreign = yield* Effect.flip(
        linking.complete(other.teammateId, "github", { state, code: "github-code" }),
      )
      assert.strictEqual(foreign.reason, "expired")
      const refused = yield* Effect.flip(
        linking.complete(admin.teammateId, "github", { state, code: "bad-code" }),
      )
      assert.strictEqual(refused.reason, "rejected")
      const fresh = new URL(yield* linking.start(admin.teammateId, "github"))
      platforms.seen.length = 0
      const freshState = fresh.searchParams.get("state")!
      const linked = yield* linking.complete(admin.teammateId, "github", {
        state: freshState,
        code: "github-code",
      })
      // A consumed attempt cannot be replayed.
      const replay = yield* Effect.flip(
        linking.complete(admin.teammateId, "github", { state: freshState, code: "github-code" }),
      )
      assert.strictEqual(replay.reason, "expired")
      assert.deepStrictEqual(
        [linked.platform, linked.workspaceId, linked.accountId, linked.displayName],
        ["github", "github.com", "4242", "octocat"],
      )
      assert.deepStrictEqual(platforms.seen.slice(0, 2), [
        `POST ${GitHubLink.GITHUB_TOKEN_URL}`,
        `GET ${GitHubLink.GITHUB_USER_URL}`,
      ])
      // The user token is never stored.
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql`SELECT * FROM teammate_link WHERE platform = 'github'`
      assert.isFalse(JSON.stringify(rows).includes("user-token"))
    }),
  )

  it.effect("cannot start a link for an unconfigured platform", () =>
    Effect.gen(function* () {
      const admin = yield* admitted(founder)
      const platforms = yield* TestPlatforms
      const unconfigured = yield* AccountLinking.make.pipe(
        Effect.provide(Layer.succeed(AccountLinkingConfig, { github: Option.none() })),
        Effect.provideService(HttpClient.HttpClient, fakePlatforms(platforms)),
      )
      assert.deepStrictEqual(unconfigured.availability, { github: false })
      const unavailable = yield* Effect.flip(unconfigured.start(admin.teammateId, "github"))
      assert.strictEqual(unavailable.reason, "unavailable")
    }),
  )
})
