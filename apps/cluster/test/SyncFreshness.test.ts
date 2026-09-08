import { assert, describe, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Option from "effect/Option"
import { GitHubInstallationId } from "@janitor/domain/GitHub/Id"
import { SyncGeneration, type SyncTargetRecord } from "@janitor/domain/GitHub/Sync"
import { freshnessOf } from "../src/SyncFreshness.ts"

const now = DateTime.makeUnsafe("2026-09-02T12:00:00.000Z")
const maxAge = Duration.hours(1)

const target = (overrides: Partial<SyncTargetRecord> = {}): SyncTargetRecord => ({
  scopeKey: "installation:1",
  scope: { _tag: "InstallationInventory", installationId: GitHubInstallationId.make("1") },
  requestedGeneration: SyncGeneration.make("3"),
  dispatchedGeneration: SyncGeneration.make("3"),
  completedGeneration: SyncGeneration.make("3"),
  verifiedGeneration: SyncGeneration.make("3"),
  requestedSequence: null,
  verifiedSequence: null,
  verifiedAt: DateTime.makeUnsafe("2026-09-02T11:30:00.000Z"),
  health: "ok",
  blockedReason: null,
  lastError: null,
  ...overrides,
})

describe("freshnessOf", () => {
  it("is projected when no target exists yet or nothing verified", () => {
    assert.strictEqual(freshnessOf(Option.none(), now, maxAge), "projected")
    assert.strictEqual(
      freshnessOf(
        Option.some(
          target({
            verifiedGeneration: SyncGeneration.make("0"),
            requestedGeneration: SyncGeneration.make("0"),
            completedGeneration: SyncGeneration.make("0"),
            verifiedAt: null,
          }),
        ),
        now,
        maxAge,
      ),
      "projected",
    )
  })

  it("is verified while the latest generation is verified and young enough", () => {
    assert.strictEqual(freshnessOf(Option.some(target()), now, maxAge), "verified")
  })

  it("is syncing while a newer generation is pending", () => {
    assert.strictEqual(
      freshnessOf(
        Option.some(target({ requestedGeneration: SyncGeneration.make("4") })),
        now,
        maxAge,
      ),
      "syncing",
    )
  })

  it("is stale when verification aged out or the last run did not verify", () => {
    assert.strictEqual(
      freshnessOf(
        Option.some(target({ verifiedAt: DateTime.makeUnsafe("2026-09-02T10:00:00.000Z") })),
        now,
        maxAge,
      ),
      "stale",
    )
    assert.strictEqual(
      freshnessOf(
        Option.some(
          target({
            requestedGeneration: SyncGeneration.make("4"),
            completedGeneration: SyncGeneration.make("4"),
            lastError: "boom",
          }),
        ),
        now,
        maxAge,
      ),
      "stale",
    )
  })

  it("is blocked whenever health is blocked", () => {
    assert.strictEqual(
      freshnessOf(
        Option.some(target({ health: "blocked", blockedReason: "suspended" })),
        now,
        maxAge,
      ),
      "blocked",
    )
  })
})
