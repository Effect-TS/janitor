// The release manifest: what this runner build speaks, reads and requires.
//
// Each contract is versioned on its own. The command protocol, the native
// migration set, the Janitor-owned state format, the checkpoint manifest and
// the bridge protocol can change independently, and the manifest names which
// versions of each this release supports. The JSON file is the pinned,
// reviewable record; this module checks it against the constants compiled into
// the bundle so a stale manifest is a visible release problem, not a guess.
import manifest from "../release-manifest.json" with { type: "json" }
import { migrations } from "@opencode/core/database/migration.gen"
import { PROTOCOL_VERSION } from "./Protocol.ts"

export interface ReleaseManifest {
  readonly manifestVersion: number
  /** The state family this release writes; older code refuses families it cannot read. */
  readonly family: string
  /** State families this release has a tested path to read, including its own. */
  readonly readableFamilies: ReadonlyArray<string>
  readonly commandProtocol: { readonly version: number; readonly accepted: ReadonlyArray<number> }
  readonly events: { readonly contract: number }
  readonly janitorState: { readonly format: number; readonly readable: ReadonlyArray<number> }
  readonly nativeMigrations: {
    readonly package: string
    readonly revision: string
    /** The last migration id of the supported set; recorded as the in-progress target. */
    readonly target: string
    readonly ids: ReadonlyArray<string>
  }
  readonly checkpoint: { readonly manifest: number; readonly archiveFormats: ReadonlyArray<string> }
  readonly bridge: {
    readonly protocol: number
    readonly required: ReadonlyArray<string>
    readonly sourceHash: string
    readonly imageDigest: string
    readonly imageId: string
    readonly baseImage: string
  }
  readonly build: {
    readonly opencode: string
    readonly effect: string
    readonly sandboxSdk: string
    readonly compatibilityDate: string
    readonly compatibilityFlags: ReadonlyArray<string>
  }
}

export const RELEASE_MANIFEST: ReleaseManifest = manifest

/** Native migration ids the pinned SDK applies. Newer ids in storage mean newer code wrote it. */
export const SUPPORTED_NATIVE_MIGRATIONS: ReadonlyArray<string> = migrations.map(
  (migration) => migration.id,
)

/** Identity of the native migration set this release initializes to. */
export const NATIVE_MIGRATION_TARGET = RELEASE_MANIFEST.nativeMigrations.target

/** The Janitor-owned `_janitor_*` state format this release writes. */
export const JANITOR_STATE_FORMAT = RELEASE_MANIFEST.janitorState.format

export const CHECKPOINT_MANIFEST_VERSION = RELEASE_MANIFEST.checkpoint.manifest

export const sameList = (left: ReadonlyArray<unknown>, right: ReadonlyArray<unknown>) =>
  left.length === right.length && left.every((value, index) => value === right[index])

/**
 * Disagreements between the pinned manifest and the compiled bundle. A release
 * with problems must not be trusted to hold or release sessions: the runner
 * reports them on its health route and Janitor refuses to release maintenance
 * against it.
 */
export const manifestProblems = (): ReadonlyArray<string> => {
  const problems: Array<string> = []
  const m = RELEASE_MANIFEST
  if (m.manifestVersion !== 1) problems.push(`manifest version ${m.manifestVersion} is unknown`)
  if (m.commandProtocol.version !== PROTOCOL_VERSION)
    problems.push(
      `manifest command protocol ${m.commandProtocol.version} differs from compiled ${PROTOCOL_VERSION}`,
    )
  if (!m.commandProtocol.accepted.includes(PROTOCOL_VERSION))
    problems.push(`manifest does not accept compiled protocol ${PROTOCOL_VERSION}`)
  if (!sameList(m.nativeMigrations.ids, SUPPORTED_NATIVE_MIGRATIONS))
    problems.push("manifest native migration set differs from the pinned SDK")
  if (
    m.nativeMigrations.target !==
    SUPPORTED_NATIVE_MIGRATIONS[SUPPORTED_NATIVE_MIGRATIONS.length - 1]
  )
    problems.push("manifest native migration target is not the last supported migration")
  if (!m.readableFamilies.includes(m.family))
    problems.push(`manifest family ${m.family} is not among its readable families`)
  if (!m.janitorState.readable.includes(m.janitorState.format))
    problems.push("manifest Janitor state format is not among its readable formats")
  if (!/^[a-f0-9]{64}$/.test(m.bridge.sourceHash))
    problems.push("manifest bridge source hash is not a SHA-256 digest")
  if (!m.bridge.imageDigest.startsWith("sha256:"))
    problems.push("manifest bridge image digest is not pinned")
  return problems
}
