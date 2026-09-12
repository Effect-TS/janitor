import { assert, layer } from "@effect/vitest"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as HttpClient from "effect/unstable/http/HttpClient"
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { AccountLinking, AccountLinkingConfig } from "../src/AccountLinking.ts"
import * as GitHubLink from "../src/Linking/GitHub.ts"
import * as SlackLink from "../src/Linking/Slack.ts"
import { Teammates, TeammatesConfig } from "../src/Teammates.ts"
import { MigratedPostgresLayer } from "./support/Postgres.ts"

const ISSUER = "https://team.cloudflareaccess.test"
const SLACK_CLIENT_ID = "slack-client"
const GITHUB_CLIENT_ID = "github-client"
const ORIGIN = "https://janitor.test"

const generateKeyPair = Effect.promise(() =>
  crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: Uint8Array.from([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  ),
)

const base64UrlJson = (value: unknown) =>
  Encoding.encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)))

interface PublicJwk {
  readonly kid: string
  readonly kty: string
  readonly n: string
  readonly e: string
}

/** What the fake Slack and GitHub answer with; tests set it per case. */
interface Platforms {
  jwk: PublicJwk
  signIdToken: (claims: Record<string, unknown>) => Effect.Effect<string>
  idTokenClaims: Record<string, unknown>
  seen: Array<string>
}

const makePlatforms = Effect.gen(function* () {
  const pair = yield* generateKeyPair
  const exported = yield* Effect.promise(() => crypto.subtle.exportKey("jwk", pair.publicKey))
  const jwk: PublicJwk = {
    kty: exported.kty ?? "",
    n: exported.n ?? "",
    e: exported.e ?? "",
    kid: "slack-key",
  }
  const signIdToken = (claims: Record<string, unknown>) =>
    Effect.gen(function* () {
      const input = `${base64UrlJson({ alg: "RS256", kid: "slack-key", typ: "JWT" })}.${base64UrlJson(claims)}`
      const signature = yield* Effect.promise(() =>
        crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(input)),
      )
      return `${input}.${Encoding.encodeBase64Url(new Uint8Array(signature))}`
    })
  const platforms: Platforms = { jwk, signIdToken, idTokenClaims: {}, seen: [] }
  return platforms
})

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  })

const fakePlatforms = (platforms: Platforms) =>
  HttpClient.make((request) =>
    Effect.gen(function* () {
      platforms.seen.push(`${request.method} ${request.url}`)
      if (request.url === SlackLink.SLACK_KEYS_URL) {
        return HttpClientResponse.fromWeb(request, json({ keys: [platforms.jwk] }))
      }
      if (request.url === SlackLink.SLACK_TOKEN_URL) {
        const form = new URLSearchParams(yield* bodyText(request))
        if (form.get("code") !== "slack-code" || form.get("client_id") !== SLACK_CLIENT_ID) {
          return HttpClientResponse.fromWeb(request, json({ ok: false, error: "invalid_code" }))
        }
        const idToken = yield* platforms.signIdToken(platforms.idTokenClaims)
        return HttpClientResponse.fromWeb(request, json({ ok: true, id_token: idToken }))
      }
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
    slack: Option.some({
      clientId: SLACK_CLIENT_ID,
      clientSecret: Redacted.make("slack-secret"),
      redirectUri: `${ORIGIN}/account/slack/return`,
      workspaceIds: ["T1"],
    }),
    github: Option.some({
      clientId: GITHUB_CLIENT_ID,
      clientSecret: Redacted.make("github-secret"),
      redirectUri: `${ORIGIN}/account/github/return`,
    }),
  }).pipe(Layer.merge(Layer.succeed(HttpClient.HttpClient, fakePlatforms(platforms))))

class TestPlatforms extends Context.Service<TestPlatforms, Platforms>()("TestPlatforms") {}

const Services = AccountLinking.layer.pipe(
  Layer.provide(Layer.unwrap(Effect.map(TestPlatforms, config))),
  Layer.provideMerge(Layer.effect(TestPlatforms, makePlatforms)),
  Layer.provideMerge(Teammates.layer),
  Layer.provide(
    Layer.succeed(TeammatesConfig, {
      initialAdmin: Option.some({ issuer: ISSUER, subject: "founder" }),
    }),
  ),
  Layer.provideMerge(MigratedPostgresLayer),
)

const founder = { issuer: ISSUER, subject: "founder", email: "founder@example.com" }
const second = { issuer: ISSUER, subject: "second", email: undefined }

const nowSeconds = Effect.map(DateTime.now, (now) => Math.floor(DateTime.toEpochMillis(now) / 1000))

const slackClaims = (nonce: string, overrides: Record<string, unknown> = {}) =>
  Effect.map(nowSeconds, (now) => ({
    iss: "https://slack.com",
    aud: SLACK_CLIENT_ID,
    sub: "U1",
    exp: now + 300,
    iat: now,
    nonce,
    "https://slack.com/team_id": "T1",
    "https://slack.com/user_id": "U1",
    name: "Founder",
    ...overrides,
  }))

const admitted = (identity: { issuer: string; subject: string; email: string | undefined }) =>
  Effect.gen(function* () {
    const admission = yield* (yield* Teammates).admit(identity)
    assert.strictEqual(admission._tag, "Admitted")
    return admission.teammate
  })

layer(Services, { timeout: "2 minutes" })("Account linking", (it) => {
  it.effect("proves a Slack account through OIDC with bound single-use state and nonce", () =>
    Effect.gen(function* () {
      const linking = yield* AccountLinking
      const platforms = yield* TestPlatforms
      const admin = yield* admitted(founder)
      const member = yield* admitted(second)
      assert.deepStrictEqual(linking.availability, { slack: true, github: true })
      const url = new URL(yield* linking.start(admin.teammateId, "slack"))
      assert.strictEqual(url.origin + url.pathname, SlackLink.SLACK_AUTHORIZE_URL)
      assert.strictEqual(url.searchParams.get("client_id"), SLACK_CLIENT_ID)
      assert.strictEqual(url.searchParams.get("redirect_uri"), `${ORIGIN}/account/slack/return`)
      assert.strictEqual(url.searchParams.get("team"), "T1")
      const state = url.searchParams.get("state")!
      // Another teammate cannot complete an attempt they did not start.
      const stolen = yield* Effect.flip(
        linking.complete(member.teammateId, "slack", { state, code: "slack-code" }),
      )
      assert.strictEqual(stolen.reason, "expired")
      // A token minted for a different nonce is rejected, and the attempt is spent.
      platforms.idTokenClaims = yield* slackClaims("other-nonce")
      const mismatch = yield* Effect.flip(
        linking.complete(admin.teammateId, "slack", { state, code: "slack-code" }),
      )
      assert.strictEqual(mismatch.reason, "rejected")
      assert.include(mismatch.message, "Start again")
      const replay = yield* Effect.flip(
        linking.complete(admin.teammateId, "slack", { state, code: "slack-code" }),
      )
      assert.strictEqual(replay.reason, "expired")
      // A fresh attempt with the matching nonce links the account.
      const fresh = new URL(yield* linking.start(admin.teammateId, "slack"))
      platforms.idTokenClaims = yield* slackClaims(fresh.searchParams.get("nonce")!)
      const linked = yield* linking.complete(admin.teammateId, "slack", {
        state: fresh.searchParams.get("state")!,
        code: "slack-code",
      })
      assert.deepStrictEqual(
        [linked.platform, linked.workspaceId, linked.accountId, linked.displayName, linked.status],
        ["slack", "T1", "U1", "Founder", "active"],
      )
      // The callback cannot be replayed once consumed.
      const again = yield* Effect.flip(
        linking.complete(admin.teammateId, "slack", {
          state: fresh.searchParams.get("state")!,
          code: "slack-code",
        }),
      )
      assert.strictEqual(again.reason, "expired")
      assert.strictEqual(
        (yield* (yield* Teammates).authorize({
          platform: "slack",
          workspaceId: "T1",
          accountId: "U1",
        }))._tag,
        "Authorized",
      )
    }),
  )

  it.effect("rejects tokens from other workspaces, audiences, signers or the past", () =>
    Effect.gen(function* () {
      const linking = yield* AccountLinking
      const platforms = yield* TestPlatforms
      const admin = yield* admitted(founder)
      const attempt = (overrides: Record<string, unknown>) =>
        Effect.gen(function* () {
          const url = new URL(yield* linking.start(admin.teammateId, "slack"))
          platforms.idTokenClaims = yield* slackClaims(url.searchParams.get("nonce")!, overrides)
          return yield* Effect.flip(
            linking.complete(admin.teammateId, "slack", {
              state: url.searchParams.get("state")!,
              code: "slack-code",
            }),
          )
        })
      const wrongWorkspace = yield* attempt({ "https://slack.com/team_id": "T-other" })
      assert.strictEqual(wrongWorkspace.reason, "rejected")
      assert.include(wrongWorkspace.message, "workspace")
      assert.strictEqual((yield* attempt({ aud: "someone-else" })).reason, "rejected")
      assert.strictEqual((yield* attempt({ iss: "https://evil.example" })).reason, "rejected")
      // The test clock starts at the epoch, so "expired" means at or before now.
      assert.strictEqual((yield* attempt({ exp: (yield* nowSeconds) - 1 })).reason, "rejected")
      // Slack refusing the code is not a proof either.
      const url = new URL(yield* linking.start(admin.teammateId, "slack"))
      const refused = yield* Effect.flip(
        linking.complete(admin.teammateId, "slack", {
          state: url.searchParams.get("state")!,
          code: "wrong-code",
        }),
      )
      assert.strictEqual(refused.reason, "rejected")
      assert.deepStrictEqual(
        (yield* (yield* Teammates).account(admin.teammateId, linking.availability)).links.map(
          (link) => link.accountId,
        ),
        ["U1"],
      )
    }),
  )

  it.effect("proves a GitHub account by numeric user lookup with a one-time token", () =>
    Effect.gen(function* () {
      const linking = yield* AccountLinking
      const platforms = yield* TestPlatforms
      const admin = yield* admitted(founder)
      const url = new URL(yield* linking.start(admin.teammateId, "github"))
      assert.strictEqual(url.origin + url.pathname, GitHubLink.GITHUB_AUTHORIZE_URL)
      assert.strictEqual(url.searchParams.get("client_id"), GITHUB_CLIENT_ID)
      assert.strictEqual(url.searchParams.get("redirect_uri"), `${ORIGIN}/account/github/return`)
      const state = url.searchParams.get("state")!
      const refused = yield* Effect.flip(
        linking.complete(admin.teammateId, "github", { state, code: "bad-code" }),
      )
      assert.strictEqual(refused.reason, "rejected")
      const fresh = new URL(yield* linking.start(admin.teammateId, "github"))
      platforms.seen.length = 0
      const linked = yield* linking.complete(admin.teammateId, "github", {
        state: fresh.searchParams.get("state")!,
        code: "github-code",
      })
      assert.deepStrictEqual(
        [linked.platform, linked.workspaceId, linked.accountId, linked.displayName],
        ["github", "github.com", "4242", "octocat"],
      )
      assert.deepStrictEqual(platforms.seen, [
        `POST ${GitHubLink.GITHUB_TOKEN_URL}`,
        `GET ${GitHubLink.GITHUB_USER_URL}`,
      ])
      // The user token is never stored.
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql`SELECT * FROM teammate_link WHERE platform = 'github'`
      assert.isFalse(JSON.stringify(rows).includes("user-token"))
    }),
  )

  it.effect("cannot start a link for a removed teammate or an unconfigured platform", () =>
    Effect.gen(function* () {
      const linking = yield* AccountLinking
      const teammates = yield* Teammates
      const admin = yield* admitted(founder)
      const member = yield* admitted(second)
      yield* teammates.remove(admin.teammateId, member.teammateId)
      const removed = yield* Effect.flip(linking.start(member.teammateId, "slack"))
      assert.strictEqual(removed.reason, "removed")
      const platforms = yield* TestPlatforms
      const unconfigured = yield* AccountLinking.make.pipe(
        Effect.provide(
          Layer.succeed(AccountLinkingConfig, { slack: Option.none(), github: Option.none() }),
        ),
        Effect.provideService(HttpClient.HttpClient, fakePlatforms(platforms)),
      )
      assert.deepStrictEqual(unconfigured.availability, { slack: false, github: false })
      const unavailable = yield* Effect.flip(unconfigured.start(admin.teammateId, "github"))
      assert.strictEqual(unavailable.reason, "unavailable")
    }),
  )
})
