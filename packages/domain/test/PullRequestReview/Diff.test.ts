import { assert, describe, it } from "@effect/vitest"
import {
  type AnchorResult,
  type DiffFile,
  type LineAnchor,
  parseTrustedDiff,
  type PullRequestFile,
  validateAnchor,
} from "@janitor/domain/PullRequestReview/Diff"

const lines = (...text: ReadonlyArray<string>) => text.join("\n")

describe("parseTrustedDiff", () => {
  it("keeps each file's RIGHT-side hunks and marks deleted and patchless files", () => {
    const cases: ReadonlyArray<readonly [string, PullRequestFile, DiffFile]> = [
      [
        "added, removed and context lines in several hunks, with a no-newline marker",
        {
          filename: "src/a.ts",
          status: "modified",
          patch: lines(
            "@@ -1,3 +1,4 @@",
            " import a",
            "-const x = 1",
            "+const x = 2",
            "+const y = 3",
            " export {}",
            "@@ -10,2 +11,3 @@ function f() {",
            "   return 1",
            "-}",
            "\\ No newline at end of file",
            "+  // end",
            "+}",
          ),
        },
        {
          _tag: "Anchorable",
          path: "src/a.ts",
          hunks: [
            {
              startLine: 1,
              endLine: 4,
              lines: ["import a", "const x = 2", "const y = 3", "export {}"],
            },
            { startLine: 11, endLine: 13, lines: ["  return 1", "  // end", "}"] },
          ],
        },
      ],
      [
        "an added file",
        { filename: "src/new.ts", status: "added", patch: lines("@@ -0,0 +1,2 @@", "+a", "+b") },
        {
          _tag: "Anchorable",
          path: "src/new.ts",
          hunks: [{ startLine: 1, endLine: 2, lines: ["a", "b"] }],
        },
      ],
      [
        "a rename with single-line hunk headers",
        {
          filename: "src/renamed.ts",
          previous_filename: "src/original.ts",
          status: "renamed",
          patch: lines("@@ -5 +5 @@", "-x", "+y"),
        },
        {
          _tag: "Anchorable",
          path: "src/renamed.ts",
          previousPath: "src/original.ts",
          hunks: [{ startLine: 5, endLine: 5, lines: ["y"] }],
        },
      ],
      [
        "a deleted file",
        { filename: "src/old.ts", status: "removed", patch: lines("@@ -1,2 +0,0 @@", "-a", "-b") },
        { _tag: "Deleted", path: "src/old.ts" },
      ],
      [
        "a file without a patch",
        { filename: "assets/logo.png", status: "modified" },
        { _tag: "Unanchorable", path: "assets/logo.png" },
      ],
    ]
    for (const [name, file, expected] of cases) {
      assert.deepStrictEqual(parseTrustedDiff([file]).files, [expected], name)
    }
  })
})

describe("validateAnchor", () => {
  const context = (start: number, end: number) =>
    lines(
      `@@ -${start},${end - start + 1} +${start},${end - start + 1} @@`,
      ...Array.from({ length: end - start + 1 }, (_, i) => ` line ${start + i}`),
    )
  const files: ReadonlyArray<PullRequestFile> = [
    {
      filename: "src/foo.ts",
      status: "modified",
      patch: lines(context(1, 3), context(40, 52), context(90, 97)),
    },
    { filename: "src/old.ts", status: "removed", patch: lines("@@ -1 +0,0 @@", "-a") },
    { filename: "assets/logo.png", status: "modified" },
  ]
  const foo = (startLine: number, endLine: number): LineAnchor => ({
    path: "src/foo.ts",
    startLine,
    endLine,
  })

  it("accepts ranges inside one RIGHT-side hunk and explains every rejection", () => {
    const cases: ReadonlyArray<readonly [string, LineAnchor, AnchorResult]> = [
      [
        "a line inside a hunk",
        foo(42, 42),
        { _tag: "Anchored", path: "src/foo.ts", startLine: 42, endLine: 42, lines: ["line 42"] },
      ],
      [
        "a multi-line range inside a hunk",
        foo(90, 92),
        {
          _tag: "Anchored",
          path: "src/foo.ts",
          startLine: 90,
          endLine: 92,
          lines: ["line 90", "line 91", "line 92"],
        },
      ],
      [
        "a line between hunks names the nearest range on each side",
        foo(88, 88),
        {
          _tag: "Invalid",
          message: "line 88 of `src/foo.ts` is not in the diff; changed ranges are 40–52, 90–97",
        },
      ],
      [
        "a line after the last hunk",
        foo(120, 120),
        {
          _tag: "Invalid",
          message: "line 120 of `src/foo.ts` is not in the diff; changed ranges are 90–97",
        },
      ],
      [
        "a range across two hunks",
        foo(50, 92),
        {
          _tag: "Invalid",
          message:
            "lines 50–92 of `src/foo.ts` are not inside one changed range; changed ranges are 40–52, 90–97",
        },
      ],
      [
        "a file outside the diff",
        { path: "src/bar.ts", startLine: 1, endLine: 1 },
        { _tag: "Invalid", message: "`src/bar.ts` is not in the diff" },
      ],
      [
        "a deleted file goes to the body",
        { path: "src/old.ts", startLine: 1, endLine: 1 },
        { _tag: "Unanchorable", path: "src/old.ts", reason: "deleted" },
      ],
      [
        "a file without a patch goes to the body",
        { path: "assets/logo.png", startLine: 1, endLine: 1 },
        { _tag: "Unanchorable", path: "assets/logo.png", reason: "no_patch" },
      ],
    ]
    const diff = parseTrustedDiff(files)
    for (const [name, anchor, expected] of cases) {
      assert.deepStrictEqual(validateAnchor(diff, anchor), expected, name)
    }
  })
})
