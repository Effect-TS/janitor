import { assert, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import type { Reproduction, TestAttempt } from "@janitor/domain/Review/Reproduction"
import { assessReproduction } from "../../src/Review/Reproduction.ts"

const base = "a".repeat(40)
const attempt: TestAttempt = {
  id: "failure",
  patchId: "patch",
  commitSha: base,
  kind: "test",
  command: "node --test test/repro.test.js",
  testPath: "test/repro.test.js",
  exitCode: 1,
  output: "not ok 1 - answer is 42\nAssertionError: expected 42 but received 41",
  truncated: false,
  integrity: true,
  limitation: null,
}
const saved: Reproduction = {
  patch: {
    id: "patch",
    baseCommit: base,
    diff: "patch",
    files: [{ path: "test/repro.test.js", content: "test", rationale: "Checks reported answer." }],
  },
  attempts: [attempt],
  assessment: null,
}
const test = {
  attemptId: "failure",
  result: "behavior_failure" as const,
  testName: "answer is 42",
  outputExcerpt: "AssertionError: expected 42 but received 41",
  relevance: "The report promises 42; this is the actual wrong answer.",
}
const input = {
  outcome: "reproduced" as const,
  rationale: "The minimal test fails on the reported value.",
  unverified: "",
  tests: [test],
  duplicate: null,
}

it.effect(
  "confirms assertion evidence, distinguishes passing behavior and rejects broken setup",
  () =>
    Effect.gen(function* () {
      assert.strictEqual(
        (yield* assessReproduction(input, saved, base, [], "owner/repo")).outcome,
        "reproduced",
      )
      for (const changed of [
        { exitCode: 0 },
        { output: "MODULE_NOT_FOUND" },
        { integrity: false },
        { limitation: "Fixture failed" },
        { patchId: "old" },
      ]) {
        const result = yield* assessReproduction(
          input,
          { ...saved, attempts: [{ ...attempt, ...changed }] },
          base,
          [],
          "owner/repo",
        ).pipe(Effect.result)
        assert.strictEqual(result._tag, "Failure")
      }
      const passing = {
        ...saved,
        attempts: [{ ...attempt, exitCode: 0, output: "ok 1 - answer is 42" }],
      }
      const passed = yield* assessReproduction(
        {
          ...input,
          outcome: "not_reproduced",
          unverified: "Other environments were not checked; the bug may still exist.",
          tests: [{ ...test, result: "passed", outputExcerpt: "ok 1 - answer is 42" }],
        },
        passing,
        base,
        [],
        "owner/repo",
      )
      assert.strictEqual(passed.outcome, "not_reproduced")
      assert.strictEqual(
        (yield* assessReproduction(
          {
            ...input,
            outcome: "inconclusive",
            tests: [],
            unverified:
              "Dependencies could not be installed. This does not establish absence of the bug.",
          },
          saved,
          base,
          [],
          "owner/repo",
        )).outcome,
        "inconclusive",
      )
    }),
)

it.effect("requires the same failing and passing test for confirmed fixed", () =>
  Effect.gen(function* () {
    const fixed = { ...input, outcome: "confirmed_fixed" as const }
    assert.strictEqual(
      (yield* assessReproduction(fixed, saved, base, [], "owner/repo").pipe(Effect.result))._tag,
      "Failure",
    )
    const comparison = {
      ...saved,
      attempts: [
        { ...attempt, commitSha: "b".repeat(40) },
        { ...attempt, id: "pass", exitCode: 0, output: "ok 1 - answer is 42" },
      ],
    }
    const compared = {
      ...fixed,
      tests: [
        test,
        {
          ...test,
          attemptId: "pass",
          result: "passed" as const,
          outputExcerpt: "ok 1 - answer is 42",
        },
      ],
    }
    assert.strictEqual(
      (yield* assessReproduction(compared, comparison, base, [], "owner/repo")).outcome,
      "confirmed_fixed",
    )
    assert.strictEqual(
      (yield* assessReproduction(
        {
          ...input,
          outcome: "appears_fixed",
          tests: [],
          unverified: "The fix is supported by code, but no historical comparison ran.",
        },
        saved,
        base,
        [],
        "owner/repo",
      )).outcome,
      "appears_fixed",
    )
    assert.strictEqual(
      (yield* assessReproduction(
        compared,
        {
          ...comparison,
          attempts: comparison.attempts.map((a) =>
            a.id === "pass" ? { ...a, command: "unrelated test" } : a,
          ),
        },
        base,
        [],
        "owner/repo",
      ).pipe(Effect.result))._tag,
      "Failure",
    )
  }),
)

it.effect("suppresses only an evidenced equivalent issue and never a closed issue alone", () =>
  Effect.gen(function* () {
    const duplicate = {
      issueNumber: 2,
      sameBehavior: "answer is 41",
      equivalentConditions: "Node 24, default config",
      trackingEvidence: "still unresolved",
      adequateReproduction: null,
      rationale: "The same minimal failure is tracked here.",
    }
    const observed = [
      {
        number: 2,
        kind: "issue" as const,
        title: "Wrong answer",
        state: "open",
        body: "answer is 41; Node 24, default config; still unresolved",
      },
    ]
    const result = yield* assessReproduction(
      { ...input, duplicate },
      saved,
      base,
      observed,
      "owner/repo",
    )
    assert.strictEqual(result.duplicate?.url, "https://github.com/owner/repo/issues/2")
    for (const items of [
      [],
      [{ ...observed[0]!, state: "closed" }],
      [{ ...observed[0]!, body: "Similar title only" }],
    ]) {
      assert.strictEqual(
        (yield* assessReproduction({ ...input, duplicate }, saved, base, items, "owner/repo").pipe(
          Effect.result,
        ))._tag,
        "Failure",
      )
    }
  }),
)

it.effect("does not treat a runner's suite-load failure as assertion evidence", () =>
  Effect.gen(function* () {
    const broken = {
      ...saved,
      attempts: [
        {
          ...attempt,
          output: "FAIL test/repro.test.js\nError: Cannot find module missing-package",
        },
      ],
    }
    const assessment = {
      ...input,
      tests: [
        { ...test, testName: "test/repro.test.js", outputExcerpt: "FAIL test/repro.test.js" },
      ],
    }
    assert.strictEqual(
      (yield* assessReproduction(assessment, broken, base, [], "owner/repo").pipe(Effect.result))
        ._tag,
      "Failure",
    )
  }),
)

it.effect("accepts a named Jest matcher failure without accepting a generic failed suite", () =>
  Effect.gen(function* () {
    const excerpt = "expect(received).toBe(expected)\nExpected: 42\nReceived: 41"
    const jest = {
      ...saved,
      attempts: [{ ...attempt, output: `FAIL test/repro.test.js\n  ✕ answer is 42\n${excerpt}` }],
    }
    assert.strictEqual(
      (yield* assessReproduction(
        { ...input, tests: [{ ...test, outputExcerpt: excerpt }] },
        jest,
        base,
        [],
        "owner/repo",
      )).outcome,
      "reproduced",
    )
  }),
)
