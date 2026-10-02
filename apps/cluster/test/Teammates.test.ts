import { assert, layer } from "@effect/vitest"
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
      const account = yield* teammates.account(later.teammateId, { github: true })
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
      const github = { platform: "github", workspaceId: "github.com" } as const
      const first = yield* teammates.link(owner.teammateId, {
        ...github,
        accountId: "100",
        displayName: "founder",
      })
      // Proving the same account again is idempotent.
      const again = yield* teammates.link(owner.teammateId, {
        ...github,
        accountId: "100",
        displayName: "founder-renamed",
      })
      assert.strictEqual(again.linkId, first.linkId)
      assert.strictEqual(again.displayName, "founder-renamed")
      // Another teammate cannot take an account that is already owned.
      const conflict = yield* Effect.flip(
        teammates.link(other.teammateId, { ...github, accountId: "100", displayName: "impostor" }),
      )
      assert.strictEqual(conflict.reason, "conflict")
      // One GitHub account per teammate; a second one replaces the first.
      const replacement = yield* teammates.link(owner.teammateId, {
        ...github,
        accountId: "101",
        displayName: "founder2",
      })
      assert.notStrictEqual(replacement.linkId, first.linkId)
      const links = (yield* teammates.account(owner.teammateId, { github: true })).links
      assert.deepStrictEqual(
        links.map((link) => [link.accountId, link.status]),
        [
          ["101", "active"],
          ["100", "replaced"],
        ],
      )
      // The replaced account is free, and so is a self-disconnected one.
      const freed = yield* teammates.link(other.teammateId, {
        ...github,
        accountId: "100",
        displayName: "second",
      })
      yield* teammates.disconnect(owner.teammateId, replacement.linkId)
      const released = (yield* teammates.account(owner.teammateId, { github: true })).links
      assert.strictEqual(released[0]?.status, "disconnected")
      // Only the owner can disconnect a link.
      const foreign = yield* Effect.flip(teammates.disconnect(owner.teammateId, freed.linkId))
      assert.strictEqual(foreign.reason, "not-found")
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
      const account = { platform: "github", workspaceId: "github.com", accountId: "300" } as const
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

  it.effect("binds a link attempt to its teammate and consumes it once", () =>
    Effect.gen(function* () {
      const teammates = yield* Teammates
      const sql = yield* SqlClient.SqlClient
      yield* sql`DELETE FROM teammate_audit`
      yield* sql`DELETE FROM teammate_link`
      yield* sql`DELETE FROM teammate`
      const owner = yield* admitted(founder)
      const other = yield* admitted(second)
      const attempt = yield* teammates.beginLink(owner.teammateId, "github")
      const wrongTeammate = yield* Effect.flip(
        teammates.consumeLinkAttempt(other.teammateId, "github", attempt.state),
      )
      assert.strictEqual(wrongTeammate.reason, "expired")
      const consumed = yield* teammates.consumeLinkAttempt(
        owner.teammateId,
        "github",
        attempt.state,
      )
      assert.strictEqual(consumed.nonce, attempt.nonce)
      const replay = yield* Effect.flip(
        teammates.consumeLinkAttempt(owner.teammateId, "github", attempt.state),
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
