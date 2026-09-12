import { assert, layer } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { Teammates, TeammatesConfig } from "../src/Teammates.ts"
import { MigratedPostgresLayer } from "./support/Postgres.ts"

const ISSUER = "https://team.cloudflareaccess.test"
const founder = { issuer: ISSUER, subject: "founder", email: "founder@example.com" }
const second = { issuer: ISSUER, subject: "second", email: undefined }
const third = { issuer: ISSUER, subject: "third", email: "third@example.com" }

const Services = Teammates.layer.pipe(
  Layer.provide(
    Layer.succeed(TeammatesConfig, {
      initialAdmin: Option.some({ issuer: ISSUER, subject: "founder" }),
    }),
  ),
  Layer.provideMerge(MigratedPostgresLayer),
)

const admitted = (identity: { issuer: string; subject: string; email: string | undefined }) =>
  Effect.gen(function* () {
    const admission = yield* (yield* Teammates).admit(identity)
    assert.strictEqual(admission._tag, "Admitted")
    return admission.teammate
  })

layer(Services, { timeout: "2 minutes" })("Teammates", (it) => {
  it.effect("admits the configured initial admin as admin and everyone else as a member", () =>
    Effect.gen(function* () {
      const teammates = yield* Teammates
      const first = yield* admitted(founder)
      assert.strictEqual(first.role, "admin")
      assert.strictEqual(first.status, "active")
      assert.strictEqual(first.email, "founder@example.com")
      const member = yield* admitted(second)
      assert.strictEqual(member.role, "member")
      assert.strictEqual(member.email, null)
      // Signing in again resolves the same teammate and refreshes display only.
      const again = yield* admitted({ ...second, email: "second@example.com" })
      assert.strictEqual(again.teammateId, member.teammateId)
      assert.strictEqual(again.email, "second@example.com")
      // A member cannot see the roster or manage anyone.
      const forbidden = yield* Effect.flip(
        teammates.setRole(member.teammateId, first.teammateId, "member"),
      )
      assert.strictEqual(forbidden.reason, "forbidden")
      const account = yield* teammates.account(member.teammateId, { slack: true, github: true })
      assert.isNull(account.team)
      const adminAccount = yield* teammates.account(first.teammateId, {
        slack: true,
        github: true,
      })
      assert.strictEqual(adminAccount.team?.length, 2)
    }),
  )

  it.effect("protects the last active admin under concurrent demotion and removal", () =>
    Effect.gen(function* () {
      const teammates = yield* Teammates
      const admin = yield* admitted(founder)
      const member = yield* admitted(second)
      const lastAdmin = yield* Effect.flip(
        teammates.setRole(admin.teammateId, admin.teammateId, "member"),
      )
      assert.strictEqual(lastAdmin.reason, "last-admin")
      const selfRemoval = yield* Effect.flip(teammates.remove(admin.teammateId, admin.teammateId))
      assert.strictEqual(selfRemoval.reason, "last-admin")
      yield* teammates.setRole(admin.teammateId, member.teammateId, "admin")
      // Two admins demote each other at once: exactly one change may land.
      const outcomes = yield* Effect.all(
        [
          Effect.exit(teammates.setRole(admin.teammateId, member.teammateId, "member")),
          Effect.exit(teammates.setRole(member.teammateId, admin.teammateId, "member")),
        ],
        { concurrency: 2 },
      )
      assert.strictEqual(outcomes.filter(Exit.isSuccess).length, 1)
      const roster = yield* teammates.roster
      assert.strictEqual(roster.filter((entry) => entry.role === "admin").length, 1)
      // The same holds for removal racing demotion.
      const remaining = roster.find((entry) => entry.role === "admin")!
      const other = roster.find((entry) => entry.role === "member")!
      yield* teammates.setRole(remaining.teammateId, other.teammateId, "admin")
      const raced = yield* Effect.all(
        [
          Effect.exit(teammates.remove(remaining.teammateId, other.teammateId)),
          Effect.exit(teammates.remove(other.teammateId, remaining.teammateId)),
        ],
        { concurrency: 2 },
      )
      assert.strictEqual(raced.filter(Exit.isSuccess).length, 1)
      const after = yield* teammates.roster
      assert.strictEqual(
        after.filter((entry) => entry.role === "admin" && entry.status === "active").length,
        1,
      )
    }),
  )

  it.effect("removal disables links and browser access until an admin restores", () =>
    Effect.gen(function* () {
      const teammates = yield* Teammates
      const sql = yield* SqlClient.SqlClient
      yield* sql`DELETE FROM teammate_audit`
      yield* sql`DELETE FROM teammate_link`
      yield* sql`DELETE FROM teammate`
      const admin = yield* admitted(founder)
      const member = yield* admitted(third)
      const slack = { platform: "slack", workspaceId: "T1", accountId: "U3" } as const
      yield* teammates.link(member.teammateId, { ...slack, displayName: "third" })
      yield* teammates.remove(admin.teammateId, member.teammateId)
      // Signing in again does not undo removal.
      const signIn = yield* teammates.admit(third)
      assert.strictEqual(signIn._tag, "Removed")
      // Neither does relinking.
      const relink = yield* Effect.flip(
        teammates.link(member.teammateId, { ...slack, displayName: "third" }),
      )
      assert.strictEqual(relink.reason, "removed")
      // The removed teammate still owns the account, so nobody else can claim it.
      const seized = yield* Effect.flip(
        teammates.link(admin.teammateId, { ...slack, displayName: "founder" }),
      )
      assert.strictEqual(seized.reason, "conflict")
      const denied = yield* teammates.authorize(slack)
      assert.deepStrictEqual(denied, { _tag: "Denied", reason: "removed" })
      const disabled = (yield* teammates.roster).find(
        (entry) => entry.teammateId === member.teammateId,
      )!
      assert.strictEqual(disabled.status, "removed")
      assert.strictEqual(disabled.links[0]?.status, "disabled")
      // Members cannot restore; admins can, and the proven link comes back.
      const forbidden = yield* Effect.flip(teammates.restore(member.teammateId, member.teammateId))
      assert.strictEqual(forbidden.reason, "forbidden")
      yield* teammates.restore(admin.teammateId, member.teammateId)
      const restored = yield* teammates.admit(third)
      assert.strictEqual(restored._tag, "Admitted")
      const authorized = yield* teammates.authorize(slack)
      assert.strictEqual(authorized._tag, "Authorized")
      const actions = yield* sql<{ action: string }>`SELECT action FROM teammate_audit ORDER BY id`
      assert.deepStrictEqual(
        actions.map((row) => row.action),
        ["link", "remove", "restore"],
      )
    }),
  )

  it.effect("keeps one owner per account, replaces with new proof and releases on disconnect", () =>
    Effect.gen(function* () {
      const teammates = yield* Teammates
      const sql = yield* SqlClient.SqlClient
      yield* sql`DELETE FROM teammate_audit`
      yield* sql`DELETE FROM teammate_link`
      yield* sql`DELETE FROM teammate`
      const admin = yield* admitted(founder)
      const member = yield* admitted(second)
      const first = yield* teammates.link(admin.teammateId, {
        platform: "slack",
        workspaceId: "T1",
        accountId: "U1",
        displayName: "founder",
      })
      // Proving the same account again is idempotent.
      const again = yield* teammates.link(admin.teammateId, {
        platform: "slack",
        workspaceId: "T1",
        accountId: "U1",
        displayName: "founder-renamed",
      })
      assert.strictEqual(again.linkId, first.linkId)
      assert.strictEqual(again.displayName, "founder-renamed")
      // Another teammate cannot take an account that is already owned.
      const conflict = yield* Effect.flip(
        teammates.link(member.teammateId, {
          platform: "slack",
          workspaceId: "T1",
          accountId: "U1",
          displayName: "impostor",
        }),
      )
      assert.strictEqual(conflict.reason, "conflict")
      // A different account in the same workspace replaces the earlier link.
      const replacement = yield* teammates.link(admin.teammateId, {
        platform: "slack",
        workspaceId: "T1",
        accountId: "U1b",
        displayName: "founder",
      })
      assert.notStrictEqual(replacement.linkId, first.linkId)
      const links = (yield* teammates.account(admin.teammateId, { slack: true, github: true }))
        .links
      assert.deepStrictEqual(
        links.map((link) => [link.accountId, link.status]),
        [
          ["U1b", "active"],
          ["U1", "replaced"],
        ],
      )
      // The replaced account is free, and so is a self-disconnected one.
      yield* teammates.link(member.teammateId, {
        platform: "slack",
        workspaceId: "T1",
        accountId: "U1",
        displayName: "second",
      })
      yield* teammates.disconnect(admin.teammateId, replacement.linkId)
      assert.deepStrictEqual(
        yield* teammates.authorize({ platform: "slack", workspaceId: "T1", accountId: "U1b" }),
        { _tag: "Denied", reason: "disconnected" },
      )
      assert.deepStrictEqual(
        yield* teammates.authorize({ platform: "slack", workspaceId: "T1", accountId: "U9" }),
        { _tag: "Denied", reason: "unknown-account" },
      )
      // Only the owner can disconnect a link.
      const foreign = yield* Effect.flip(
        teammates.disconnect(admin.teammateId, (yield* teammates.roster)[1]!.links[0]!.linkId),
      )
      assert.strictEqual(foreign.reason, "not-found")
      // One GitHub account per teammate; a second one replaces the first.
      yield* teammates.link(admin.teammateId, {
        platform: "github",
        workspaceId: "github.com",
        accountId: "100",
        displayName: "founder",
      })
      yield* teammates.link(admin.teammateId, {
        platform: "github",
        workspaceId: "github.com",
        accountId: "101",
        displayName: "founder2",
      })
      const github = (yield* teammates.account(admin.teammateId, {
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
      const admin = yield* admitted(founder)
      const member = yield* admitted(second)
      const account = { platform: "slack", workspaceId: "T1", accountId: "U-shared" } as const
      const outcomes = yield* Effect.all(
        [
          Effect.exit(teammates.link(admin.teammateId, { ...account, displayName: "a" })),
          Effect.exit(teammates.link(member.teammateId, { ...account, displayName: "b" })),
        ],
        { concurrency: 2 },
      )
      assert.strictEqual(outcomes.filter(Exit.isSuccess).length, 1)
      const owners = yield* sql`SELECT teammate_id FROM teammate_link WHERE status = 'active'`
      assert.strictEqual(owners.length, 1)
    }),
  )

  it.effect("serializes platform authorization against removal in one transaction", () =>
    Effect.gen(function* () {
      const teammates = yield* Teammates
      const sql = yield* SqlClient.SqlClient
      yield* sql`DELETE FROM teammate_audit`
      yield* sql`DELETE FROM teammate_link`
      yield* sql`DELETE FROM teammate`
      const admin = yield* admitted(founder)
      const member = yield* admitted(second)
      const account = { platform: "slack", workspaceId: "T1", accountId: "U2" } as const
      yield* teammates.link(member.teammateId, { ...account, displayName: "second" })
      const authorized = yield* Deferred.make<void>()
      const accepted: Array<string> = []
      // Acceptance holds the authorization inside its transaction; removal
      // waits for it and the accepted input keeps its outcome.
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
            Effect.andThen(teammates.remove(admin.teammateId, member.teammateId)),
          ),
        ],
        { concurrency: 2 },
      )
      assert.deepStrictEqual(accepted, [member.teammateId])
      // After removal committed, the same account is denied even with a fresh
      // browser session, and long after any Access session would have expired.
      assert.deepStrictEqual(yield* teammates.authorize(account), {
        _tag: "Denied",
        reason: "removed",
      })
    }),
  )

  it.effect("binds a link attempt to its teammate and platform and consumes it once", () =>
    Effect.gen(function* () {
      const teammates = yield* Teammates
      const sql = yield* SqlClient.SqlClient
      yield* sql`DELETE FROM teammate_audit`
      yield* sql`DELETE FROM teammate_link`
      yield* sql`DELETE FROM teammate`
      const admin = yield* admitted(founder)
      const member = yield* admitted(second)
      const attempt = yield* teammates.beginLink(admin.teammateId, "slack")
      const wrongTeammate = yield* Effect.flip(
        teammates.consumeLinkAttempt(member.teammateId, "slack", attempt.state),
      )
      assert.strictEqual(wrongTeammate.reason, "expired")
      const wrongPlatform = yield* Effect.flip(
        teammates.consumeLinkAttempt(admin.teammateId, "github", attempt.state),
      )
      assert.strictEqual(wrongPlatform.reason, "expired")
      const consumed = yield* teammates.consumeLinkAttempt(admin.teammateId, "slack", attempt.state)
      assert.strictEqual(consumed.nonce, attempt.nonce)
      const replay = yield* Effect.flip(
        teammates.consumeLinkAttempt(admin.teammateId, "slack", attempt.state),
      )
      assert.strictEqual(replay.reason, "expired")
      const stale = yield* teammates.beginLink(admin.teammateId, "github")
      yield* sql`UPDATE teammate_link_attempt SET expires_at = now() - interval '1 minute' WHERE state::text = ${stale.state}`
      const expired = yield* Effect.flip(
        teammates.consumeLinkAttempt(admin.teammateId, "github", stale.state),
      )
      assert.strictEqual(expired.reason, "expired")
      const garbage = yield* Effect.flip(
        teammates.consumeLinkAttempt(admin.teammateId, "github", "not-a-state"),
      )
      assert.strictEqual(garbage.reason, "expired")
    }),
  )
})
