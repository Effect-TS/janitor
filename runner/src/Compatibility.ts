// The outer compatibility decision, taken before any SDK host exists.
//
// The `_janitor_*` compatibility record and the native migration journal are
// the only inputs. The decision never mutates state: it either names the one
// reason execution must stay blocked for operator repair, or says what host
// construction must do first (nothing, resume the same migration target, or
// upgrade the Janitor-owned state format). Unknown or newer state is never
// mistaken for a fresh database.
import { RELEASE_MANIFEST, SUPPORTED_NATIVE_MIGRATIONS, sameList } from "./ReleaseManifest.ts"

export interface MigrationIntent {
  /** The native migration set identity being initialized toward. */
  readonly target: string
  readonly release: string
  readonly startedAt: number
}

/** The stable outer record, readable before host construction. Format 2 is current. */
export interface Compatibility {
  readonly formatVersion: number
  /** State family that wrote the record; absent on format 1 records. */
  readonly family?: string
  readonly protocol: number
  readonly release: string
  /** Native migration ids recorded at the last completed initialization. */
  readonly nativeMigrations: ReadonlyArray<string>
  /** Set while an initialization is in flight; a format 1 record stored the release string. */
  readonly inProgress: MigrationIntent | string | null
}

export type CompatibilityDecision =
  | { readonly kind: "blocked"; readonly reason: string }
  | {
      readonly kind: "ready"
      /** Host construction must persist intent and initialize before serving work. */
      readonly initialize: boolean
      /** The Janitor-owned state format must be upgraded to the current one. */
      readonly upgradeFormat: boolean
      /** An interrupted initialization toward this release's target resumes. */
      readonly resume: boolean
    }

export interface CompatibilityInput {
  readonly record: Compatibility | undefined
  /** Native tables exist: the SDK bootstrapped this database at least once. */
  readonly nativeInitialized: boolean
  /** Ids in the native migration journal. */
  readonly applied: ReadonlyArray<string>
}

const target = () => RELEASE_MANIFEST.nativeMigrations.target

export const decideCompatibility = (input: CompatibilityInput): CompatibilityDecision => {
  const manifest = RELEASE_MANIFEST
  const { record, nativeInitialized, applied } = input
  const unknown = applied.filter((id) => !SUPPORTED_NATIVE_MIGRATIONS.includes(id))
  if (unknown.length > 0)
    return {
      kind: "blocked",
      reason: `native state contains newer migrations (${unknown.join(", ")}); this release has no path to read it`,
    }
  if (record === undefined) {
    if (nativeInitialized)
      return {
        kind: "blocked",
        reason: "native state has no compatibility record; operator migration required",
      }
    return { kind: "ready", initialize: true, upgradeFormat: false, resume: false }
  }
  if (!manifest.janitorState.readable.includes(record.formatVersion))
    return {
      kind: "blocked",
      reason: `compatibility record format ${record.formatVersion} is not supported by this release`,
    }
  if (record.family !== undefined && !manifest.readableFamilies.includes(record.family))
    return {
      kind: "blocked",
      reason: `state was written by ${record.family}; this release (${manifest.family}) has no tested path to read it`,
    }
  const upgradeFormat = record.formatVersion !== manifest.janitorState.format
  if (record.inProgress !== null) {
    const intent = record.inProgress
    const progress = `${applied.length} of ${SUPPORTED_NATIVE_MIGRATIONS.length} supported migrations recorded`
    if (typeof intent === "string")
      return {
        kind: "blocked",
        reason: `native initialization by ${intent} did not complete (${progress}); operator repair required`,
      }
    if (intent.target !== target())
      return {
        kind: "blocked",
        reason: `native migration to ${intent.target} by ${intent.release} did not complete (${progress}); this release targets ${target()} and cannot resume it`,
      }
    // Every committed step belongs to this release's set: the same target resumes.
    return { kind: "ready", initialize: true, upgradeFormat, resume: true }
  }
  const initialize =
    upgradeFormat || !sameList(record.nativeMigrations, SUPPORTED_NATIVE_MIGRATIONS)
  return { kind: "ready", initialize, upgradeFormat, resume: false }
}
