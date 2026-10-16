/**
 * The trusted diff: GitHub's PR files API for the pinned head SHA, parsed into
 * `RIGHT`-side hunks that finding anchors are validated against.
 */

/** The fields janitor reads from one entry of `GET /pulls/{n}/files`. */
export interface PullRequestFile {
  readonly filename: string
  readonly status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged"
  readonly previous_filename?: string
  readonly patch?: string
}

/** One hunk's `RIGHT`-side lines: `lines[i]` is the text of line `startLine + i`. */
export interface Hunk {
  readonly startLine: number
  readonly endLine: number
  readonly lines: ReadonlyArray<string>
}

/**
 * A changed file. `Unanchorable` is a file GitHub sent without a `patch`;
 * `Deleted` has no `RIGHT` side at all.
 */
export type DiffFile =
  | {
      readonly _tag: "Anchorable"
      readonly path: string
      readonly previousPath?: string
      readonly hunks: ReadonlyArray<Hunk>
    }
  | { readonly _tag: "Unanchorable"; readonly path: string }
  | { readonly _tag: "Deleted"; readonly path: string }

export interface TrustedDiff {
  readonly files: ReadonlyArray<DiffFile>
}

const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** Hunks with no `RIGHT`-side lines, such as pure deletions, are left out. */
const parseHunks = (patch: string): ReadonlyArray<Hunk> => {
  const hunks: Array<Hunk> = []
  let startLine = 0
  let lines: Array<string> = []
  /** `RIGHT`-side lines the current hunk's header still promises. */
  let remaining = 0
  const close = () => {
    if (lines.length > 0) {
      hunks.push({ startLine, endLine: startLine + lines.length - 1, lines })
    }
    lines = []
  }
  for (const line of patch.split("\n")) {
    const header = hunkHeader.exec(line)
    if (header !== null) {
      close()
      startLine = Number(header[3])
      remaining = Number(header[4] ?? "1")
    } else if (remaining > 0 && (line[0] === "+" || line[0] === " " || line === "")) {
      // An empty line inside a hunk is a context line whose leading space was trimmed.
      lines.push(line.slice(1))
      remaining--
    }
    // `-` lines, `\ No newline at end of file` and anything else carry no `RIGHT`-side line.
  }
  close()
  return hunks
}

const parseFile = (file: PullRequestFile): DiffFile => {
  if (file.status === "removed") return { _tag: "Deleted", path: file.filename }
  if (file.patch === undefined) return { _tag: "Unanchorable", path: file.filename }
  const hunks = parseHunks(file.patch)
  return file.previous_filename === undefined
    ? { _tag: "Anchorable", path: file.filename, hunks }
    : { _tag: "Anchorable", path: file.filename, previousPath: file.previous_filename, hunks }
}

export const parseTrustedDiff = (files: ReadonlyArray<PullRequestFile>): TrustedDiff => ({
  files: files.map(parseFile),
})

export interface LineAnchor {
  readonly path: string
  readonly startLine: number
  readonly endLine: number
}

/**
 * What `reportFinding` learns from the diff: the anchored `RIGHT`-side lines,
 * a file that can only be listed in the review body, or an error for the model.
 */
export type AnchorResult =
  | {
      readonly _tag: "Anchored"
      readonly path: string
      readonly startLine: number
      readonly endLine: number
      readonly lines: ReadonlyArray<string>
    }
  | {
      readonly _tag: "Unanchorable"
      readonly path: string
      readonly reason: "no_patch" | "deleted"
    }
  | { readonly _tag: "Invalid"; readonly message: string }

const formatRange = (start: number, end: number) => (start === end ? `${start}` : `${start}–${end}`)

/** The last hunk starting at or before the anchor and the first ending at or after it. */
const nearestRanges = (hunks: ReadonlyArray<Hunk>, anchor: LineAnchor) => {
  const before = hunks.findLast((hunk) => hunk.startLine <= anchor.startLine)
  const after = hunks.find((hunk) => hunk.endLine >= anchor.endLine)
  return [...new Set([before, after])].flatMap((hunk) =>
    hunk === undefined ? [] : [formatRange(hunk.startLine, hunk.endLine)],
  )
}

export const validateAnchor = (diff: TrustedDiff, anchor: LineAnchor): AnchorResult => {
  const file = diff.files.find((candidate) => candidate.path === anchor.path)
  if (file === undefined)
    return { _tag: "Invalid", message: `\`${anchor.path}\` is not in the diff` }
  if (file._tag === "Deleted") return { _tag: "Unanchorable", path: file.path, reason: "deleted" }
  if (file._tag === "Unanchorable")
    return { _tag: "Unanchorable", path: file.path, reason: "no_patch" }
  const hunk = file.hunks.find(
    (candidate) => candidate.startLine <= anchor.startLine && anchor.endLine <= candidate.endLine,
  )
  if (hunk !== undefined) {
    const offset = anchor.startLine - hunk.startLine
    return {
      _tag: "Anchored",
      ...anchor,
      lines: hunk.lines.slice(offset, offset + anchor.endLine - anchor.startLine + 1),
    }
  }
  const problem =
    anchor.startLine === anchor.endLine
      ? `line ${anchor.startLine} of \`${file.path}\` is not in the diff`
      : `lines ${formatRange(anchor.startLine, anchor.endLine)} of \`${file.path}\` are not inside one changed range`
  const ranges = nearestRanges(file.hunks, anchor)
  return {
    _tag: "Invalid",
    message: ranges.length === 0 ? problem : `${problem}; changed ranges are ${ranges.join(", ")}`,
  }
}
