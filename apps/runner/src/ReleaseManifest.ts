// The release manifest: what this runner build speaks, reads and requires.
//
// The manifest pins the runner protocol, native migrations, SQLite workspace
// format and dependency versions. Deployment and maintenance validate it.
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
  readonly workspace: {
    readonly storage: string
    readonly format: number
    readonly tools: ReadonlyArray<string>
  }
  readonly build: {
    readonly opencode: string
    readonly effect: string
    readonly effectSource: string
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
  if (m.workspace.storage !== "sqlite" || m.workspace.format !== 1)
    problems.push("unsupported workspace format")
  return problems
}
