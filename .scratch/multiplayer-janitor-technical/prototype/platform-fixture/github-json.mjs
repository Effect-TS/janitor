// Node 24 JSON.parse source text preserves large GitHub numeric delivery IDs.
// A production runtime must verify source-text reviver support or use a lossless parser.
export function parseGitHubJSON(raw) {
  return JSON.parse(raw, (_key, value, context) => {
    if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      if (!context || !/^-?\d+$/.test(context.source))
        throw new Error("Cannot preserve unsafe GitHub integer exactly")
      return context.source
    }
    return value
  })
}
