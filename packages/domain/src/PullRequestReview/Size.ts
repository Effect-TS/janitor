import { fileName } from "./Diff.ts"

/**
 * The size count behind the oversized check (EFF-1652 point 5): changed lines
 * and files, leaving out lockfiles, files the base SHA's `.gitattributes`
 * mark `linguist-generated`, and `.changeset/*`.
 */

export interface SizedFile {
  readonly filename: string
  readonly additions: number
  readonly deletions: number
}

export interface Size {
  readonly lines: number
  readonly files: number
}

/** One `.gitattributes` file and the directory it sits in (`""` for the root). */
export interface Gitattributes {
  readonly directory: string
  readonly text: string
}

interface GeneratedRule {
  readonly pattern: RegExp
  readonly generated: boolean
}

const escape = (character: string) => character.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")

/**
 * A `.gitattributes` pattern as a regular expression over repository paths.
 * Directory patterns (a trailing `/`) never match a file, so they're dropped.
 */
const patternRegExp = (raw: string): RegExp | undefined => {
  if (raw.endsWith("/")) return undefined
  // A slash anywhere but the end anchors the pattern at the root.
  const anchored = raw.includes("/")
  const pattern = raw.startsWith("/") ? raw.slice(1) : raw
  let source = ""
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!
    if (character === "*" && pattern[index + 1] === "*") {
      const leading = index === 0 || pattern[index - 1] === "/"
      if (leading && pattern[index + 2] === "/") {
        source += "(?:.*/)?"
        index += 2
        continue
      }
      if (leading && index + 2 === pattern.length) {
        source += ".*"
        index += 1
        continue
      }
    }
    if (character === "*") source += "[^/]*"
    else if (character === "?") source += "[^/]"
    else if (character === "[" && pattern.indexOf("]", index + 2) !== -1) {
      const end = pattern.indexOf("]", index + 2)
      const body = pattern.slice(index + 1, end)
      source += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`
      index = end
    } else if (character === "\\" && index + 1 < pattern.length) source += escape(pattern[++index]!)
    else source += escape(character)
  }
  return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${source}$`)
}

/** `linguist-generated` or `=true` sets it; `-`, `!` or any other value unsets it. */
const generatedValue = (attributes: ReadonlyArray<string>): boolean | undefined => {
  let value: boolean | undefined
  for (const attribute of attributes) {
    if (attribute === "linguist-generated") value = true
    else if (attribute === "-linguist-generated" || attribute === "!linguist-generated")
      value = false
    else if (attribute.startsWith("linguist-generated="))
      value = attribute === "linguist-generated=true"
  }
  return value
}

const generatedRules = (gitattributes: string): ReadonlyArray<GeneratedRule> =>
  gitattributes.split(/\r?\n/).flatMap((line) => {
    const [raw, ...attributes] = line.trim().split(/\s+/)
    // Negative patterns are not allowed in `.gitattributes`.
    if (raw === undefined || raw === "" || raw.startsWith("#") || raw.startsWith("!")) return []
    const generated = generatedValue(attributes)
    if (generated === undefined) return []
    const pattern = patternRegExp(raw)
    return pattern === undefined ? [] : [{ pattern, generated }]
  })

/**
 * The directories whose `.gitattributes` can apply to `paths`, shallowest
 * first, as `countedSize` expects them: the root (`""`) and every ancestor.
 */
export const ancestorDirectories = (paths: ReadonlyArray<string>): ReadonlyArray<string> => {
  const directories = new Set([""])
  for (const path of paths) {
    for (let end = path.lastIndexOf("/"); end > 0; end = path.lastIndexOf("/", end - 1))
      directories.add(path.slice(0, end))
  }
  // An ancestor's path is always shorter than its descendants'.
  return [...directories].sort((a, b) => a.length - b.length)
}

/**
 * Patterns are relative to their file's directory. Later lines override
 * earlier ones, and a deeper file overrides a shallower one.
 */
const isGenerated = (
  files: ReadonlyArray<{ readonly prefix: string; readonly rules: ReadonlyArray<GeneratedRule> }>,
  path: string,
) =>
  files.reduce(
    (generated, file) =>
      path.startsWith(file.prefix)
        ? file.rules.reduce(
            (generated, rule) =>
              rule.pattern.test(path.slice(file.prefix.length)) ? rule.generated : generated,
            generated,
          )
        : generated,
    false,
  )

export const countedSize = (
  files: ReadonlyArray<SizedFile>,
  options: {
    readonly lockfiles: ReadonlyArray<string>
    /** The base SHA's `.gitattributes` files that can apply, shallowest first. */
    readonly gitattributes: ReadonlyArray<Gitattributes>
  },
): Size => {
  const rules = options.gitattributes.map((file) => ({
    prefix: file.directory === "" ? "" : `${file.directory}/`,
    rules: generatedRules(file.text),
  }))
  const counted = files.filter(
    (file) =>
      !options.lockfiles.includes(fileName(file.filename)) &&
      !/^\.changeset\/[^/]+$/.test(file.filename) &&
      !isGenerated(rules, file.filename),
  )
  return {
    lines: counted.reduce((total, file) => total + file.additions + file.deletions, 0),
    files: counted.length,
  }
}
