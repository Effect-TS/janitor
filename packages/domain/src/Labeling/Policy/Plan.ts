import * as Schema from "effect/Schema"
import { GitHubLabelDatabaseId } from "../../GitHub/Id.ts"
import { PolicyId } from "./Condition.ts"
import { Outcome } from "./Program.ts"

/**
 * Rules and the planner (plan: "Rules", "Plan"). A rule binds one label to
 * one policy and says what a miss means. The planner turns outcomes into
 * label changes without knowing how any outcome was produced.
 */

export const RuleId = Schema.String.check(Schema.isMinLength(1))
  .pipe(Schema.brand("RuleId"))
  .annotate({
    identifier: "RuleId",
  })
export type RuleId = typeof RuleId.Type

export const OnNoMatch = Schema.Literals(["ensure-absent", "preserve"]).annotate({
  identifier: "OnNoMatch",
})
export type OnNoMatch = typeof OnNoMatch.Type

export const RuleGroup = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100))

/** The fields the planner reads. Persistence adds status, version, and audit around these. */
export const RuleBinding = Schema.Struct({
  id: RuleId,
  labelId: GitHubLabelDatabaseId,
  policyId: PolicyId,
  onNoMatch: OnNoMatch,
  /** Rules in one group are exclusive: the matching rule with the lowest priority wins. */
  group: Schema.NullOr(RuleGroup),
  priority: Schema.Int,
  enabled: Schema.Boolean,
}).annotate({ identifier: "RuleBinding" })
export type RuleBinding = typeof RuleBinding.Type

export const RuleOutcome = Schema.Struct({
  ruleId: RuleId,
  outcome: Outcome,
  /** True when the rule matched and won its group, or has no group. */
  selected: Schema.Boolean,
}).annotate({ identifier: "RuleOutcome" })
export type RuleOutcome = typeof RuleOutcome.Type

export const LabelAction = Schema.Struct({
  labelId: GitHubLabelDatabaseId,
  action: Schema.Literals(["add", "remove"]),
  ruleId: RuleId,
}).annotate({ identifier: "LabelAction" })
export type LabelAction = typeof LabelAction.Type

export const Plan = Schema.Struct({
  rules: Schema.Array(RuleOutcome),
  /** Only changes against the current labels, in label order. */
  actions: Schema.Array(LabelAction),
}).annotate({ identifier: "Plan" })
export type Plan = typeof Plan.Type

export interface PlanInput {
  readonly rules: ReadonlyArray<RuleBinding>
  readonly outcomes: ReadonlyMap<RuleId, Outcome>
  readonly currentLabels: ReadonlySet<GitHubLabelDatabaseId>
}

/**
 * 1. Matching rules are candidates; within a group the lowest priority wins
 *    and the rest are treated as misses.
 * 2. A selected rule wants its label present.
 * 3. A missing rule with ensure-absent wants its label absent.
 * 4. Unknown and not-applicable want nothing.
 * 5. Per label, present beats absent.
 */
export const plan = ({ rules, outcomes, currentLabels }: PlanInput): Plan => {
  const enabled = rules.filter((rule) => rule.enabled)
  const winners = new Map<string, RuleId>()
  for (const rule of enabled) {
    if (rule.group === null || outcomes.get(rule.id) !== "match") continue
    const current = winners.get(rule.group)
    const incumbent =
      current === undefined ? undefined : enabled.find((entry) => entry.id === current)
    if (
      incumbent === undefined ||
      rule.priority < incumbent.priority ||
      (rule.priority === incumbent.priority && rule.id < incumbent.id)
    ) {
      winners.set(rule.group, rule.id)
    }
  }

  const ruleOutcomes: Array<RuleOutcome> = []
  const wantPresent = new Map<GitHubLabelDatabaseId, RuleId>()
  const wantAbsent = new Map<GitHubLabelDatabaseId, RuleId>()
  for (const rule of enabled) {
    const outcome = outcomes.get(rule.id) ?? "unknown"
    const won = rule.group === null || winners.get(rule.group) === rule.id
    const selected = outcome === "match" && won
    ruleOutcomes.push({ ruleId: rule.id, outcome, selected })
    if (selected) {
      if (!wantPresent.has(rule.labelId)) wantPresent.set(rule.labelId, rule.id)
      continue
    }
    const missed = outcome === "no-match" || (outcome === "match" && !won)
    if (missed && rule.onNoMatch === "ensure-absent" && !wantAbsent.has(rule.labelId)) {
      wantAbsent.set(rule.labelId, rule.id)
    }
  }

  const actions: Array<LabelAction> = []
  for (const [labelId, ruleId] of wantPresent) {
    if (!currentLabels.has(labelId)) actions.push({ labelId, action: "add", ruleId })
  }
  for (const [labelId, ruleId] of wantAbsent) {
    if (!wantPresent.has(labelId) && currentLabels.has(labelId)) {
      actions.push({ labelId, action: "remove", ruleId })
    }
  }
  actions.sort((left, right) => left.labelId.localeCompare(right.labelId))
  return { rules: ruleOutcomes, actions }
}
