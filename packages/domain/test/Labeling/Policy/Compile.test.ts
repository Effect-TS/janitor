import { assert, describe, it } from "@effect/vitest"
import { compile } from "@janitor/domain/Labeling/Policy/Compile"
import { type Condition, PolicyId } from "@janitor/domain/Labeling/Policy/Condition"
import type { Program } from "@janitor/domain/Labeling/Policy/Program"

const fact = (fact: string, operator: string, value?: unknown): Condition =>
  ({
    _tag: "Fact",
    fact,
    operator,
    ...(value === undefined ? {} : { value }),
    caseSensitive: false,
  }) as Condition
const program = (
  matchesWhen: Condition,
  target: Program["target"] = "pull_request",
  appliesWhen: Condition | null = null,
): Program => ({
  target,
  appliesWhen,
  evaluator: { _tag: "Conditions", matchesWhen },
})
const none = () => undefined

describe("Compile", () => {
  it("produces a manifest of facts, tracks, and references", () => {
    const gate = PolicyId.make("gate")
    const result = compile({
      program: program(
        {
          _tag: "All",
          conditions: [
            fact("baseRef", "equals", "main"),
            { _tag: "Policy", policyId: gate },
            fact("labels", "has", "11"),
          ],
        },
        "pull_request",
        {
          _tag: "Collection",
          fact: "checks",
          quantifier: "every",
          where: fact("state", "equals", "success") as never,
        },
      ),
      resolve: (id) =>
        id === gate ? { program: program(fact("title", "contains", "x")) } : undefined,
    })
    assert.strictEqual(result._tag, "Compiled")
    if (result._tag !== "Compiled") return
    assert.deepStrictEqual(result.manifest.facts, ["baseRef", "checks", "labels", "title"])
    assert.deepStrictEqual(result.manifest.tracks, [
      "checks",
      "entities",
      "labels",
      "pull_requests",
    ])
    assert.deepStrictEqual(result.manifest.references, [gate])
    assert.strictEqual(result.manifest.nodeCount, 6)
    assert.strictEqual(result.manifest.expandedNodeCount, 7)
  })

  it("rejects facts the target does not carry, missing and cyclic references, and oversized programs", () => {
    const kind = compile({ program: program(fact("draft", "is", true), "issue"), resolve: none })
    assert.strictEqual(kind._tag === "Rejected" ? kind.issue.code : kind._tag, "fact-kind-mismatch")

    const missing = compile({
      program: program({ _tag: "Policy", policyId: PolicyId.make("nope") }),
      resolve: none,
    })
    assert.strictEqual(
      missing._tag === "Rejected" ? missing.issue.code : missing._tag,
      "missing-reference",
    )

    const self = PolicyId.make("self")
    const cycle = compile({
      program: program({ _tag: "Policy", policyId: self }),
      resolve: () => ({ program: program(fact("title", "isEmpty")) }),
      policyId: self,
    })
    assert.strictEqual(cycle._tag === "Rejected" ? cycle.issue.code : cycle._tag, "reference-cycle")

    const other = PolicyId.make("other")
    const mismatch = compile({
      program: program({ _tag: "Policy", policyId: other }),
      resolve: () => ({ program: program(fact("title", "isEmpty"), "issue") }),
    })
    assert.strictEqual(
      mismatch._tag === "Rejected" ? mismatch.issue.code : mismatch._tag,
      "reference-target-mismatch",
    )

    let deep: Condition = fact("title", "isEmpty")
    for (let level = 0; level < 9; level++) deep = { _tag: "Not", condition: deep }
    const limit = compile({ program: program(deep), resolve: none })
    assert.strictEqual(limit._tag === "Rejected" ? limit.issue.code : limit._tag, "limit-exceeded")
    assert.include(limit._tag === "Rejected" ? limit.issue.message : "", "matchesWhen > not")
  })
})
