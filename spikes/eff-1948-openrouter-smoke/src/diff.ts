// Unified-diff parsing: which files a PR changes and which new-side line
// ranges its hunks cover. `reportFinding` anchors must fall inside them, the
// way janitor's review anchors (EFF-1950) must be placeable on the diff.

export interface Range {
  readonly start: number
  readonly end: number
}

export interface DiffIndex {
  readonly files: ReadonlyArray<string>
  readonly hunks: ReadonlyMap<string, ReadonlyArray<Range>>
}

export const indexDiff = (diff: string): DiffIndex => {
  const hunks = new Map<string, Array<Range>>()
  let current: string | undefined
  for (const line of diff.split("\n")) {
    const file = /^\+\+\+ b\/(.+)$/.exec(line)
    if (file) {
      current = file[1]
      if (!hunks.has(current)) hunks.set(current, [])
      continue
    }
    if (line.startsWith("+++ /dev/null")) {
      current = undefined
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunk && current !== undefined) {
      const start = Number(hunk[1])
      const count = hunk[2] === undefined ? 1 : Number(hunk[2])
      if (count > 0) hunks.get(current)!.push({ start, end: start + count - 1 })
    }
  }
  return { files: [...hunks.keys()], hunks }
}

export const inRanges = (ranges: ReadonlyArray<Range>, line: number): boolean =>
  ranges.some((r) => line >= r.start && line <= r.end)

export const formatRanges = (ranges: ReadonlyArray<Range>): string =>
  ranges.map((r) => (r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`)).join(", ")
