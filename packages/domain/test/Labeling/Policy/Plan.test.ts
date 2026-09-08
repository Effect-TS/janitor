import { assert, describe, it } from "@effect/vitest"
import { GitHubLabelDatabaseId } from "@janitor/domain/GitHub/Id"
import { PolicyId } from "@janitor/domain/Labeling/Policy/Condition"
import { plan, type RuleBinding, RuleId } from "@janitor/domain/Labeling/Policy/Plan"
import type { Outcome } from "@janitor/domain/Labeling/Policy/Program"

const bug = GitHubLabelDatabaseId.make("11")
const feature = GitHubLabelDatabaseId.make("12")
const policy = PolicyId.make("p")
const rule = (id: string, overrides: Partial<RuleBinding> = {}): RuleBinding => ({
  id: RuleId.make(id),
  labelId: bug,
  policyId: policy,
  onNoMatch: "ensure-absent",
  group: null,
  priority: 0,
  enabled: true,
  ...overrides,
})
const run = (
  rules: ReadonlyArray<RuleBinding>,
  outcomes: Record<string, Outcome>,
  current: ReadonlyArray<string> = [],
) =>
  plan({
    rules,
    outcomes: new Map(Object.entries(outcomes).map(([id, outcome]) => [RuleId.make(id), outcome])),
    currentLabels: new Set(current.map((id) => GitHubLabelDatabaseId.make(id))),
  })

describe("Plan", () => {
  it("adds on match, removes on miss with ensure-absent, and leaves unknown alone", () => {
    assert.deepStrictEqual(run([rule("a")], { a: "match" }).actions, [
      { labelId: bug, action: "add", ruleId: RuleId.make("a") },
    ])
    assert.deepStrictEqual(run([rule("a")], { a: "match" }, ["11"]).actions, [])
    assert.deepStrictEqual(run([rule("a")], { a: "no-match" }, ["11"]).actions, [
      { labelId: bug, action: "remove", ruleId: RuleId.make("a") },
    ])
    assert.deepStrictEqual(
      run([rule("a", { onNoMatch: "preserve" })], { a: "no-match" }, ["11"]).actions,
      [],
    )
    assert.deepStrictEqual(run([rule("a")], { a: "unknown" }, ["11"]).actions, [])
    assert.deepStrictEqual(run([rule("a")], { a: "not-applicable" }, ["11"]).actions, [])
    assert.deepStrictEqual(run([rule("a", { enabled: false })], { a: "match" }).rules, [])
  })

  it("lets present beat absent across rules for one label", () => {
    const result = run(
      [rule("a"), rule("b", { policyId: PolicyId.make("q") })],
      { a: "match", b: "no-match" },
      ["11"],
    )
    assert.deepStrictEqual(result.actions, [])
    assert.deepStrictEqual(
      result.rules.map((entry) => entry.selected),
      [true, false],
    )
  })

  it("resolves a group by lowest priority and removes the losers' labels", () => {
    const rules = [
      rule("high", { group: "size", priority: 10, labelId: bug }),
      rule("low", { group: "size", priority: 1, labelId: feature }),
    ]
    const result = run(rules, { high: "match", low: "match" }, ["11"])
    assert.deepStrictEqual(result.rules, [
      { ruleId: RuleId.make("high"), outcome: "match", selected: false },
      { ruleId: RuleId.make("low"), outcome: "match", selected: true },
    ])
    assert.deepStrictEqual(result.actions, [
      { labelId: bug, action: "remove", ruleId: RuleId.make("high") },
      { labelId: feature, action: "add", ruleId: RuleId.make("low") },
    ])
    // A losing rule that preserves keeps its label.
    const preserved = run(
      [
        rules[0]!,
        {
          ...rules[0]!,
          id: RuleId.make("keep"),
          onNoMatch: "preserve",
          priority: 5,
          labelId: feature,
        },
      ],
      { high: "match", keep: "match" },
      ["11", "12"],
    )
    assert.deepStrictEqual(preserved.actions, [
      { labelId: bug, action: "remove", ruleId: RuleId.make("high") },
    ])
  })
})
