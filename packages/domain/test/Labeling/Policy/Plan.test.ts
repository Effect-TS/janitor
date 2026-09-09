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
  onMatch: "ensure-present",
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
  it("independently removes on match and restores on non-match", () => {
    const inverted = rule("inverted", { onMatch: "ensure-absent", onNoMatch: "ensure-present" })
    assert.deepStrictEqual(run([inverted], { inverted: "match" }, ["11"]).actions, [
      { labelId: bug, action: "remove", ruleId: RuleId.make("inverted") },
    ])
    assert.deepStrictEqual(run([inverted], { inverted: "no-match" }).actions, [
      { labelId: bug, action: "add", ruleId: RuleId.make("inverted") },
    ])
  })
  it("takes no action independently for either result and ignores inconclusive results", () => {
    for (const outcome of ["match", "no-match"] as const) {
      const inactive = rule(
        "a",
        outcome === "match"
          ? { onMatch: "no-action", onNoMatch: "ensure-absent" }
          : { onMatch: "ensure-absent", onNoMatch: "no-action" },
      )
      assert.deepStrictEqual(run([inactive], { a: outcome }, ["11"]).actions, [])
      assert.deepStrictEqual(run([inactive], { a: outcome }).actions, [])
    }
    for (const outcome of ["unknown", "failed", "not-applicable"] as const) {
      const inverted = rule("a", { onMatch: "ensure-absent", onNoMatch: "ensure-present" })
      assert.deepStrictEqual(run([inverted], { a: outcome }, ["11"]).actions, [])
      assert.deepStrictEqual(run([inverted], { a: outcome }).actions, [])
    }
  })
  it("records the requested action even when the label already has the desired state", () => {
    assert.strictEqual(
      run([rule("a")], { a: "match" }, ["11"]).rules[0]?.requestedAction,
      "ensure-present",
    )
    assert.strictEqual(
      run([rule("a", { onMatch: "no-action" })], { a: "match" }, ["11"]).rules[0]?.requestedAction,
      "no-action",
    )
  })
  it("preserves affected labels even when legacy rules share ownership", () => {
    for (const unresolved of ["unknown", "failed"] as const) {
      assert.deepStrictEqual(
        run([rule("a"), rule("b")], { a: unresolved, b: "no-match" }, ["11"]).actions,
        [],
      )
      assert.deepStrictEqual(run([rule("a"), rule("b")], { a: unresolved, b: "match" }).actions, [])
    }
  })
  it("preserves a labeling group with an unknown or failed evaluation while unrelated rules act", () => {
    for (const unresolved of ["unknown", "failed"] as const) {
      const result = run(
        [
          rule("unresolved", { group: "kind", labelId: bug }),
          rule("match", { group: "kind", labelId: feature }),
          rule("miss", { group: "kind", labelId: GitHubLabelDatabaseId.make("13") }),
          rule("independent", { labelId: GitHubLabelDatabaseId.make("14") }),
        ],
        { unresolved, match: "match", miss: "no-match", independent: "match" },
        ["11", "13"],
      )
      assert.deepStrictEqual(result.actions, [
        {
          labelId: GitHubLabelDatabaseId.make("14"),
          action: "add",
          ruleId: RuleId.make("independent"),
        },
      ])
      assert.deepStrictEqual(
        result.rules.map((rule) => rule.selected),
        [false, false, false, true],
      )
      assert.deepStrictEqual(run([rule("a")], { a: unresolved }, ["11"]).actions, [])
    }
  })

  it("adds on match, removes on miss with ensure-absent, and leaves unknown alone", () => {
    assert.deepStrictEqual(run([rule("a")], { a: "match" }).actions, [
      { labelId: bug, action: "add", ruleId: RuleId.make("a") },
    ])
    assert.deepStrictEqual(run([rule("a")], { a: "match" }, ["11"]).actions, [])
    assert.deepStrictEqual(run([rule("a")], { a: "no-match" }, ["11"]).actions, [
      { labelId: bug, action: "remove", ruleId: RuleId.make("a") },
    ])
    assert.deepStrictEqual(
      run([rule("a", { onNoMatch: "no-action" })], { a: "no-match" }, ["11"]).actions,
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

  it("resolves a group by highest priority and removes the losers' labels", () => {
    const rules = [
      rule("high", { group: "size", priority: 1, labelId: bug }),
      rule("low", { group: "size", priority: 10, labelId: feature }),
    ]
    const result = run(rules, { high: "match", low: "match" }, ["11"])
    assert.deepStrictEqual(result.rules, [
      {
        ruleId: RuleId.make("high"),
        outcome: "match",
        selected: false,
        requestedAction: "ensure-absent",
      },
      {
        ruleId: RuleId.make("low"),
        outcome: "match",
        selected: true,
        requestedAction: "ensure-present",
      },
    ])
    assert.deepStrictEqual(result.actions, [
      { labelId: bug, action: "remove", ruleId: RuleId.make("high") },
      { labelId: feature, action: "add", ruleId: RuleId.make("low") },
    ])
    // A losing presence request removes its label regardless of its non-match action.
    const preserved = run(
      [
        rules[0]!,
        {
          ...rules[0]!,
          id: RuleId.make("keep"),
          onNoMatch: "no-action",
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
