import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import {
  fingerprint,
  type HeadBlob,
  type HeadMatch,
  matchAtHead,
} from "@janitor/domain/PullRequestReview/Fingerprint"

// The comment and line numbers aren't inputs, so a reworded comment or code
// that moved keeps its fingerprint by construction.
describe("fingerprint", () => {
  it.effect("ignores whitespace and changes with the anchored code or the path", () =>
    Effect.gen(function* () {
      const original = ["if (x) {", "  return y"]
      const cases: ReadonlyArray<
        readonly [string, readonly [string, ReadonlyArray<string>], boolean]
      > = [
        ["the same code", ["src/a.ts", ["if (x) {", "  return y"]], true],
        [
          "re-indented with tabs and trailing spaces",
          ["src/a.ts", ["\tif (x) {  ", "\t\treturn y"]],
          true,
        ],
        ["spacing inside a line", ["src/a.ts", ["if  (x)  {", "  return   y"]], true],
        ["edited code", ["src/a.ts", ["if (x) {", "  return z"]], false],
        ["another path", ["src/b.ts", original], false],
      ]
      const expected = yield* fingerprint("src/a.ts", original)
      for (const [name, [path, lines], same] of cases) {
        assert.strictEqual((yield* fingerprint(path, lines)) === expected, same, name)
      }
    }),
  )
})

describe("matchAtHead", () => {
  it.effect("finds the snippet anywhere in the head blob, and unreadable is unknown", () =>
    Effect.gen(function* () {
      const target = {
        path: "src/a.ts",
        fingerprint: yield* fingerprint("src/a.ts", ["if (x) {", "  return y"]),
        lineCount: 2,
      }
      const read = (...lines: ReadonlyArray<string>): HeadBlob => ({
        _tag: "Read",
        text: lines.join("\n"),
      })
      const cases: ReadonlyArray<readonly [string, HeadBlob, HeadMatch]> = [
        [
          "moved and re-indented, outside every hunk",
          read("a", "b", "c", "function f() {", "    if (x) {", "      return y", "    }", "}"),
          { _tag: "Matches", startLine: 5, endLine: 6 },
        ],
        ["edited", read("if (x) {", "  return z", "}"), { _tag: "Gone" }],
        ["removed", read("export {}"), { _tag: "Gone" }],
        ["missing or over 1 MB", { _tag: "Unreadable" }, { _tag: "Unknown" }],
      ]
      for (const [name, blob, expected] of cases) {
        assert.deepStrictEqual(yield* matchAtHead(target, blob), expected, name)
      }
    }),
  )
})
