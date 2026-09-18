import { assert, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { validatePatch } from "../../src/Review/Patch.ts"

it.effect("builds a test-only patch against the recorded tree", () =>
  Effect.gen(function* () {
    const patch = yield* validatePatch({
      baseCommit: "a".repeat(40),
      tree: [{ path: "test/existing.test.js", mode: "100644", type: "blob", sha: "b".repeat(40) }],
      files: [
        {
          path: "./test/repro.test.js",
          content: "assert.equal(answer, 42)\n",
          rationale: "Checks the reported wrong answer.",
        },
      ],
      originals: {},
    })
    assert.strictEqual(patch.baseCommit, "a".repeat(40))
    assert.include(patch.diff, "+++ b/test/repro.test.js\n")
    assert.include(patch.diff, "+assert.equal(answer, 42)\n")
    assert.strictEqual(patch.files[0]?.path, "test/repro.test.js")
  }),
)

it.effect("refuses production, configuration, traversal and ambiguous layouts", () =>
  Effect.gen(function* () {
    for (const path of [
      "src/index.js",
      "test/package.json",
      "test/vite.config.ts",
      "../test/a.test.js",
      "test/../a.test.js",
      "/test/a.test.js",
      "new/a.test.js",
      "test/.github/a.yml",
      "test/pnpm-workspace.yaml",
    ]) {
      const result = yield* validatePatch({
        baseCommit: "a".repeat(40),
        tree: [{ path: "test/a.test.js", mode: "100644", type: "blob", sha: "b".repeat(40) }],
        files: [{ path, content: "changed\n", rationale: "test" }],
        originals: {},
      }).pipe(Effect.result)
      assert.strictEqual(result._tag, "Failure", path)
    }
  }),
)

it.effect("rejects symlinks, submodules, binary contents and patch limits", () =>
  Effect.gen(function* () {
    const base = {
      baseCommit: "a".repeat(40),
      tree: [{ path: "test/a.test.js", mode: "100644", type: "blob", sha: "b".repeat(40) }],
      originals: {},
    }
    for (const mode of ["120000", "160000"]) {
      const result = yield* validatePatch({
        ...base,
        tree: [...base.tree, { path: "test/linked", mode, type: "blob", sha: "b".repeat(40) }],
        files: [{ path: "test/linked/repro.test.js", content: "test\n", rationale: "test" }],
      }).pipe(Effect.result)
      assert.strictEqual(result._tag, "Failure")
    }
    for (const content of ["binary\0data", "x".repeat(128001)]) {
      assert.strictEqual(
        (yield* validatePatch({
          ...base,
          files: [{ path: "test/repro.test.js", content, rationale: "test" }],
        }).pipe(Effect.result))._tag,
        "Failure",
      )
    }
    assert.strictEqual(
      (yield* validatePatch({
        ...base,
        files: Array.from({ length: 21 }, (_, index) => ({
          path: `test/${index}.test.js`,
          content: "test\n",
          rationale: "test",
        })),
      }).pipe(Effect.result))._tag,
      "Failure",
    )
  }),
)

it.effect("does not admit disguised build or dependency configuration as fixtures", () =>
  Effect.gen(function* () {
    for (const path of [
      "test/CMakeLists.txt",
      "test/setup.py",
      "test/deno.json",
      "test/gradle.properties",
      "test/.yarnrc.yml",
    ]) {
      const result = yield* validatePatch({
        baseCommit: "a".repeat(40),
        tree: [{ path: "test/a.test.js", mode: "100644", type: "blob", sha: "b".repeat(40) }],
        originals: {},
        files: [{ path, content: "changed\n", rationale: "fixture" }],
      }).pipe(Effect.result)
      assert.strictEqual(result._tag, "Failure", path)
    }
  }),
)

it.effect("discovers colocated tests at the repository root", () =>
  Effect.gen(function* () {
    const patch = yield* validatePatch({
      baseCommit: "a".repeat(40),
      tree: [{ path: "existing.test.js", mode: "100644", type: "blob", sha: "b".repeat(40) }],
      originals: {},
      files: [
        {
          path: "repro.test.js",
          content: "test\n",
          rationale: "Minimal reproduction alongside the existing root test.",
        },
      ],
    })
    assert.strictEqual(patch.files[0]?.path, "repro.test.js")
  }),
)
