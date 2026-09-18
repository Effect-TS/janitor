import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

export const PATCH_BYTES = 128_000
export const PATCH_FILES = 20
export const TreeEntry = Schema.Struct({
  path: Schema.String,
  mode: Schema.String,
  type: Schema.String,
  sha: Schema.String,
})
export type TreeEntry = typeof TreeEntry.Type
export const ProposedFile = Schema.Struct({
  path: Schema.String.check(Schema.isMaxLength(500)),
  content: Schema.String.check(Schema.isMaxLength(PATCH_BYTES)),
  rationale: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
})
export const ProposedFiles = Schema.Array(ProposedFile).check(Schema.isMaxLength(PATCH_FILES))

/** Canonical Git paths only. Never resolve traversal supplied by an agent. */
export const canonicalPath = (path: string): string | null => {
  const normalized = path.replace(/^(\.\/)+/, "")
  return normalized.length === 0 ||
    /[^a-zA-Z0-9_./@+ -]/.test(normalized) ||
    normalized
      .split("/")
      .some((part) => part === "" || part === "." || part === ".." || part === ".git")
    ? null
    : normalized
}

const directory = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")))
const testFile = (path: string) =>
  /(?:^|\/)(?:test_[^/]+|[^/]+(?:\.test|\.spec|_test)\.[^/]+)$/.test(path)
const testRoot = (path: string) => /^(.*?(?:^|\/)(?:tests?|__tests__|spec))\//.exec(path)?.[1]
const forbidden = (path: string) =>
  /(?:^|\/)(?:\.github|node_modules|vendor|dist|build)(?:\/|$)/i.test(path) ||
  /(?:^|\/)(?:package(?:-lock)?\.json|pnpm-(?:lock|workspace)\.yaml|yarn\.lock|bun\.lockb?|Cargo\.(?:toml|lock)|go\.(?:mod|sum)|requirements[^/]*|pyproject\.toml|poetry\.lock|Gemfile[^/]*|Dockerfile[^/]*|Makefile|CMakeLists\.txt|setup\.(?:py|cfg)|deno\.jsonc?|gradle\.properties|.*\.gradle(?:\.kts)?|pom\.xml|.*\.csproj|\.[^/]*rc(?:\.[^/]+)?|[^/]*\.config\.[^/]+|tsconfig[^/]*\.json|\.npmrc|\.pnpmfile\.[^/]+)$/i.test(
    path,
  )
const bytes = (text: string) => new TextEncoder().encode(text).length
const binary = (text: string) =>
  Array.from(text).some((char) => {
    const code = char.charCodeAt(0)
    return code === 0xfffd || (code < 32 && code !== 9 && code !== 10 && code !== 13)
  })
const lines = (text: string, prefix: string) => {
  if (text === "") return ""
  const parts = text.split("\n")
  const terminated = parts.at(-1) === ""
  if (terminated) parts.pop()
  return (
    parts.map((line) => `${prefix}${line}\n`).join("") +
    (terminated ? "" : "\\ No newline at end of file\n")
  )
}
const count = (text: string) =>
  text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0)

/** Tree and original contents come from trusted GitHub reads at baseCommit, never the guest. */
export const validatePatch = (input: {
  readonly baseCommit: string
  readonly tree: ReadonlyArray<TreeEntry>
  readonly files: typeof ProposedFiles.Type
  readonly originals: Readonly<Record<string, string>>
}) =>
  Effect.gen(function* () {
    if (!/^[a-f0-9]{40}$/.test(input.baseCommit))
      return yield* Effect.fail("Invalid recorded base commit.")
    if (input.files.length === 0 || input.files.length > PATCH_FILES)
      return yield* Effect.fail("A patch must contain 1 to 20 files.")
    const entries = new Map(input.tree.map((entry) => [entry.path, entry]))
    const roots = new Set(
      input.tree
        .filter((entry) => entry.type === "blob" && entry.mode === "100644" && testFile(entry.path))
        .flatMap((entry) => {
          const root = testRoot(entry.path)
          return root === undefined ? [] : [root]
        }),
    )
    const seen = new Set<string>()
    const files: Array<typeof ProposedFile.Type> = []
    let diff = ""
    for (const file of input.files) {
      const path = canonicalPath(file.path)
      if (path === null || seen.has(path))
        return yield* Effect.fail(`Invalid or duplicate path: ${file.path}`)
      seen.add(path)
      if (forbidden(path)) return yield* Effect.fail(`Forbidden patch path: ${path}`)
      const root = testRoot(path)
      const siblingTest = input.tree.some(
        (entry) =>
          entry.mode === "100644" &&
          testFile(entry.path) &&
          directory(entry.path) === directory(path),
      )
      if (!(testFile(path) && siblingTest) && !(root !== undefined && roots.has(root)))
        return yield* Effect.fail(`Cannot establish existing test-only layout for ${path}.`)
      for (let parts = path.split("/"); parts.length > 0; parts.pop()) {
        const entry = entries.get(parts.join("/"))
        if (
          entry !== undefined &&
          (entry.mode === "120000" ||
            entry.mode === "160000" ||
            (parts.length < path.split("/").length && entry.type !== "tree"))
        )
          return yield* Effect.fail(`Symlink, submodule or non-directory path: ${path}`)
      }
      const entry = entries.get(path)
      if (entry !== undefined && (entry.type !== "blob" || entry.mode !== "100644"))
        return yield* Effect.fail(`Not an ordinary text file: ${path}`)
      const before = entry === undefined ? "" : input.originals[path]
      if (before === undefined) return yield* Effect.fail(`Missing trusted base contents: ${path}`)
      if (binary(before) || binary(file.content))
        return yield* Effect.fail(`Binary patch rejected: ${path}`)
      if (file.rationale.trim() === "")
        return yield* Effect.fail(`Test-only rationale required: ${path}`)
      if (before === file.content) continue
      const oldCount = count(before)
      const newCount = count(file.content)
      diff += `diff --git a/${path} b/${path}\n${entry === undefined ? "new file mode 100644\n" : ""}--- ${entry === undefined ? "/dev/null" : `a/${path}`}\n+++ b/${path}\n@@ -${oldCount === 0 ? 0 : 1},${oldCount} +${newCount === 0 ? 0 : 1},${newCount} @@\n${lines(before, "-")}${lines(file.content, "+")}`
      files.push({ ...file, path })
      if (bytes(diff) > PATCH_BYTES) return yield* Effect.fail("Patch exceeds 128000 bytes.")
    }
    if (files.length === 0) return yield* Effect.fail("The patch has no changes.")
    return { baseCommit: input.baseCommit, diff, files }
  })
