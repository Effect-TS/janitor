import { assert, layer } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/sql/SqlClient"
import { Teammates } from "../src/Teammates.ts"
import { MigratedPostgresLayer } from "./support/Postgres.ts"

const ISSUER = "https://team.cloudflareaccess.test"
const founder = { issuer: ISSUER, subject: "founder", email: "founder@example.com" }
const second = { issuer: ISSUER, subject: "second", email: undefined }

const Services = Teammates.layer.pipe(Layer.provideMerge(MigratedPostgresLayer))

const admitted = (identity: { issuer: string; subject: string; email: string | undefined }) =>
  Effect.flatMap(Teammates, (teammates) => teammates.admit(identity))

layer(Services, { timeout: "2 minutes" })("Teammates", (it) => {
  it.effect("admits every Access identity as a teammate and resolves it again on sign-in", () =>
    Effect.gen(function* () {
      const teammates = yield* Teammates
      const first = yield* admitted(founder)
      assert.strictEqual(first.email, "founder@example.com")
      const later = yield* admitted(second)
      assert.strictEqual(later.email, null)
      // Signing in again resolves the same teammate and refreshes display only.
      const again = yield* admitted({ ...second, email: "second@example.com" })
      assert.strictEqual(again.teammateId, later.teammateId)
      assert.strictEqual(again.email, "second@example.com")
      const account = yield* teammates.account(later.teammateId, { slack: true, github: true })
      assert.strictEqual(account.teammate.teammateId, later.teammateId)
      assert.deepStrictEqual(account.links, [])
    }),
  )

  it.effect("keeps one owner per account, replaces with new proof and releases on disconnect", () =>
    Effect.gen(function* () {
      const teammates = yield* Teammates
      const sql = yield* SqlClient.SqlClient
      yield* sql`DELETE FROM teammate_audit`
      yield* sql`DELETE FROM teammate_link`
      yield* sql`DELETE FROM teammate`
      const owner = yield* admitted(founder)
      const other = yield* admitted(second)
      const first = yield* teammates.link(owner.teammateId, {
        platform: "slack",
        workspaceId: "T1",
        accountId: "U1",
        displayName: "founder",
      })
      // Proving the same account again is idempotent.
      const again = yield* teammates.link(owner.teammateId, {
        platform: "slack",
        workspaceId: "T1",
        accountId: "U1",
        displayName: "founder-renamed",
      })
      assert.strictEqual(again.linkId, first.linkId)
      assert.strictEqual(again.displayName, "founder-renamed")
      // Another teammate cannot take an account that is already owned.
      const conflict = yield* Effect.flip(
        teammates.link(other.teammateId, {
          platform: "slack",
          workspaceId: "T1",
          accountId: "U1",
          displayName: "impostor",
        }),
      )
      assert.strictEqual(conflict.reason, "conflict")
      // A different account in the same workspace replaces the earlier link.
      const replacement = yield* teammates.link(owner.teammateId, {
        platform: "slack",
        workspaceId: "T1",
        accountId: "U1b",
        displayName: "founder",
      })
      assert.notStrictEqual(replacement.linkId, first.linkId)
      const links = (yield* teammates.account(owner.teammateId, { slack: true, github: true }))
        .links
      assert.deepStrictEqual(
        links.map((link) => [link.accountId, link.status]),
        [
          ["U1b", "active"],
          ["U1", "replaced"],
        ],
      )
      // The replaced account is free, and so is a self-disconnected one.
      const freed = yield* teammates.link(other.teammateId, {
        platform: "slack",
        workspaceId: "T1",
        accountId: "U1",
        displayName: "second",
      })
      yield* teammates.disconnect(owner.teammateId, replacement.linkId)
      assert.deepStrictEqual(
        yield* teammates.authorize({ platform: "slack", workspaceId: "T1", accountId: "U1b" }),
        { _tag: "Denied", reason: "disconnected" },
      )
      assert.deepStrictEqual(
        yield* teammates.authorize({ platform: "slack", workspaceId: "T1", accountId: "U9" }),
        { _tag: "Denied", reason: "unknown-account" },
      )
      // Only the owner can disconnect a link.
      const foreign = yield* Effect.flip(teammates.disconnect(owner.teammateId, freed.linkId))
      assert.strictEqual(foreign.reason, "not-found")
      // One GitHub account per teammate; a second one replaces the first.
      yield* teammates.link(owner.teammateId, {
        platform: "github",
        workspaceId: "github.com",
        accountId: "100",
        displayName: "founder",
      })
      yield* teammates.link(owner.teammateId, {
        platform: "github",
        workspaceId: "github.com",
        accountId: "101",
        displayName: "founder2",
      })
      const github = (yield* teammates.account(owner.teammateId, {
        slack: true,
        github: true,
      })).links.filter((link) => link.platform === "github")
      assert.deepStrictEqual(
        github.map((link) => [link.accountId, link.status]),
        [
          ["101", "active"],
          ["100", "replaced"],
        ],
      )
    }),
  )

  it.effect("gives conflicting concurrent links of one account exactly one owner", () =>
    Effect.gen(function* () {
      const teammates = yield* Teammates
      const sql = yield* SqlClient.SqlClient
      yield* sql`DELETE FROM teammate_audit`
      yield* sql`DELETE FROM teammate_link`
      yield* sql`DELETE FROM teammate`
      const owner = yield* admitted(founder)
      const other = yield* admitted(second)
      const account = { platform: "slack", workspaceId: "T1", accountId: "U-shared" } as const
      const outcomes = yield* Effect.all(
        [
          Effect.exit(teammates.link(owner.teammateId, { ...account, displayName: "a" })),
          Effect.exit(teammates.link(other.teammateId, { ...account, displayName: "b" })),
        ],
        { concurrency: 2 },
      )
      assert.strictEqual(outcomes.filter(Exit.isSuccess).length, 1)
      const owners = yield* sql`SELECT teammate_id FROM teammate_link WHERE status = 'active'`
      assert.strictEqual(owners.length, 1)
    }),
  )

  it.effect("serializes platform authorization against disconnection in one transaction", () =>
    Effect.gen(function* () {
      const teammates = yield* Teammates
      const sql = yield* SqlClient.SqlClient
      yield* sql`DELETE FROM teammate_audit`
      yield* sql`DELETE FROM teammate_link`
      yield* sql`DELETE FROM teammate`
      const other = yield* admitted(second)
      const account = { platform: "slack", workspaceId: "T1", accountId: "U2" } as const
      const link = yield* teammates.link(other.teammateId, { ...account, displayName: "second" })
      const authorized = yield* Deferred.make<void>()
      const accepted: Array<string> = []
      // Acceptance holds the authorization inside its transaction; a
      // disconnect waits for it and the accepted input keeps its outcome.
      yield* Effect.all(
        [
          sql.withTransaction(
            Effect.gen(function* () {
              const decision = yield* teammates.authorize(account)
              yield* Deferred.succeed(authorized, undefined)
              yield* sql`SELECT pg_sleep(0.2)`
              if (decision._tag === "Authorized") accepted.push(decision.teammateId)
            }),
          ),
          Deferred.await(authorized).pipe(
            Effect.andThen(teammates.disconnect(other.teammateId, link.linkId)),
          ),
        ],
        { concurrency: 2 },
      )
      assert.deepStrictEqual(accepted, [other.teammateId])
      // Once the disconnect commits, the same account is denied.
      assert.deepStrictEqual(yield* teammates.authorize(account), {
        _tag: "Denied",
        reason: "disconnected",
      })
    }),
  )

  it.effect("authorizes a linked account with no browser session at all", () =>
    Effect.gen(function* () {
      const teammates = yield* Teammates
      const sql = yield* SqlClient.SqlClient
      yield* sql`DELETE FROM teammate_audit`
      yield* sql`DELETE FROM teammate_link`
      yield* sql`DELETE FROM teammate`
      const other = yield* admitted(second)
      const account = { platform: "github", workspaceId: "github.com", accountId: "7" } as const
      yield* teammates.link(other.teammateId, { ...account, displayName: "second" })
      // Nothing about Access reaches this seam: platform authority rests on
      // the link alone, so an expired or absent browser session changes nothing.
      const decision = yield* teammates.authorize(account)
      assert.strictEqual(decision._tag, "Authorized")
      if (decision._tag === "Authorized") {
        assert.strictEqual(decision.teammateId, other.teammateId)
      }
    }),
  )

  it.effect("binds a link attempt to its teammate and platform and consumes it once", () =>
    Effect.gen(function* () {
      const teammates = yield* Teammates
      const sql = yield* SqlClient.SqlClient
      yield* sql`DELETE FROM teammate_audit`
      yield* sql`DELETE FROM teammate_link`
      yield* sql`DELETE FROM teammate`
      const owner = yield* admitted(founder)
      const other = yield* admitted(second)
      const attempt = yield* teammates.beginLink(owner.teammateId, "slack")
      const wrongTeammate = yield* Effect.flip(
        teammates.consumeLinkAttempt(other.teammateId, "slack", attempt.state),
      )
      assert.strictEqual(wrongTeammate.reason, "expired")
      const wrongPlatform = yield* Effect.flip(
        teammates.consumeLinkAttempt(owner.teammateId, "github", attempt.state),
      )
      assert.strictEqual(wrongPlatform.reason, "expired")
      const consumed = yield* teammates.consumeLinkAttempt(owner.teammateId, "slack", attempt.state)
      assert.strictEqual(consumed.nonce, attempt.nonce)
      const replay = yield* Effect.flip(
        teammates.consumeLinkAttempt(owner.teammateId, "slack", attempt.state),
      )
      assert.strictEqual(replay.reason, "expired")
      const stale = yield* teammates.beginLink(owner.teammateId, "github")
      yield* sql`UPDATE teammate_link_attempt SET expires_at = now() - interval '1 minute' WHERE state::text = ${stale.state}`
      const expired = yield* Effect.flip(
        teammates.consumeLinkAttempt(owner.teammateId, "github", stale.state),
      )
      assert.strictEqual(expired.reason, "expired")
      const garbage = yield* Effect.flip(
        teammates.consumeLinkAttempt(owner.teammateId, "github", "not-a-state"),
      )
      assert.strictEqual(garbage.reason, "expired")
    }),
  )
})
