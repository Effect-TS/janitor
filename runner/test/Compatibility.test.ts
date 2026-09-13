// Outer compatibility decisions: pure, and never a guess that state is fresh.
import { describe, expect, it } from "vitest"
import { decideCompatibility, type Compatibility } from "../src/Compatibility.ts"
import { RELEASE_MANIFEST, SUPPORTED_NATIVE_MIGRATIONS } from "../src/ReleaseManifest.ts"

const supported = SUPPORTED_NATIVE_MIGRATIONS
const current: Compatibility = {
  formatVersion: RELEASE_MANIFEST.janitorState.format,
  family: RELEASE_MANIFEST.family,
  protocol: 2,
  release: "r1",
  nativeMigrations: supported,
  inProgress: null,
}

describe("decideCompatibility", () => {
  it("initializes a fresh database and serves a current record without work", () => {
    expect(
      decideCompatibility({ record: undefined, nativeInitialized: false, applied: [] }),
    ).toEqual({ kind: "ready", initialize: true, upgradeFormat: false, resume: false })
    expect(
      decideCompatibility({ record: current, nativeInitialized: true, applied: supported }),
    ).toEqual({ kind: "ready", initialize: false, upgradeFormat: false, resume: false })
  })

  it("blocks native state without metadata and newer migrations", () => {
    expect(
      decideCompatibility({ record: undefined, nativeInitialized: true, applied: supported }),
    ).toMatchObject({ kind: "blocked", reason: expect.stringMatching(/no compatibility record/) })
    expect(
      decideCompatibility({
        record: current,
        nativeInitialized: true,
        applied: [...supported, "99999999999999_future"],
      }),
    ).toMatchObject({ kind: "blocked", reason: expect.stringMatching(/newer migrations/) })
  })

  it("refuses formats and families it has no tested path to read", () => {
    expect(
      decideCompatibility({
        record: { ...current, formatVersion: 99 },
        nativeInitialized: true,
        applied: supported,
      }),
    ).toMatchObject({ kind: "blocked", reason: expect.stringMatching(/format 99/) })
    expect(
      decideCompatibility({
        record: { ...current, family: "janitor-runner-9" },
        nativeInitialized: true,
        applied: supported,
      }),
    ).toMatchObject({ kind: "blocked", reason: expect.stringMatching(/no tested path/) })
  })

  it("resumes an interrupted initialization only toward its own target", () => {
    const partial = supported.slice(0, 3)
    const own = {
      target: RELEASE_MANIFEST.nativeMigrations.target,
      release: "r1",
      startedAt: 1,
    }
    expect(
      decideCompatibility({
        record: { ...current, nativeMigrations: [], inProgress: own },
        nativeInitialized: true,
        applied: partial,
      }),
    ).toEqual({ kind: "ready", initialize: true, upgradeFormat: false, resume: true })
    const other = decideCompatibility({
      record: { ...current, nativeMigrations: [], inProgress: { ...own, target: "elsewhere" } },
      nativeInitialized: true,
      applied: partial,
    })
    expect(other).toMatchObject({ kind: "blocked" })
    expect((other as { reason: string }).reason).toContain(`3 of ${supported.length}`)
    expect((other as { reason: string }).reason).toContain("cannot resume")
    // Format 1 stored the release string; a stranded string intent is not resumable.
    expect(
      decideCompatibility({
        record: { ...current, formatVersion: 1, inProgress: "older-release" },
        nativeInitialized: true,
        applied: partial,
      }),
    ).toMatchObject({ kind: "blocked", reason: expect.stringMatching(/older-release/) })
  })

  it("upgrades a readable older format and forward-migrates an older native set under intent", () => {
    expect(
      decideCompatibility({
        record: { ...current, formatVersion: 1, family: undefined },
        nativeInitialized: true,
        applied: supported,
      }),
    ).toEqual({ kind: "ready", initialize: true, upgradeFormat: true, resume: false })
    expect(
      decideCompatibility({
        record: { ...current, nativeMigrations: supported.slice(0, -1) },
        nativeInitialized: true,
        applied: supported.slice(0, -1),
      }),
    ).toEqual({ kind: "ready", initialize: true, upgradeFormat: false, resume: false })
  })
})
