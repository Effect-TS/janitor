import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { GitHubLabelDatabaseId } from "../../GitHub/Id.ts"
import { PolicyId } from "./Condition.ts"
import { Outcome } from "./Program.ts"

/**
 * Rules and the planner (plan: "Rules", "Plan"). A rule binds one label to
 * one policy and configures an action for each conclusive result. The planner turns outcomes into
 * label changes without knowing how any outcome was produced.
 */

export const RuleId = Schema.String.check(Schema.isMinLength(1))
  .pipe(Schema.brand("RuleId"))
  .annotate({
    identifier: "RuleId",
  })
export type RuleId = typeof RuleId.Type

export const ResultAction = Schema.Literals([
  "ensure-present",
  "ensure-absent",
  "no-action",
]).annotate({
  identifier: "ResultAction",
})
export type ResultAction = typeof ResultAction.Type

/** Unknown, failed, and not-applicable results never request a label change. */
export const resultAction = (
  rule: { readonly onMatch: ResultAction; readonly onNoMatch: ResultAction },
  outcome: Outcome,
): ResultAction =>
  outcome === "match" ? rule.onMatch : outcome === "no-match" ? rule.onNoMatch : "no-action"

export const describeResultAction = (action: ResultAction): string => {
  switch (action) {
    case "ensure-present":
      return "Ensure present"
    case "ensure-absent":
      return "Ensure absent"
    case "no-action":
      return "Take no action"
  }
}

export const RuleGroup = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100))

/** The fields the planner reads. Persistence adds status, version, and audit around these. */
export const RuleBinding = Schema.Struct({
  id: RuleId,
  labelId: GitHubLabelDatabaseId,
  policyId: PolicyId,
  onMatch: ResultAction.pipe(Schema.withDecodingDefaultKey(Effect.succeed("ensure-present"))),
  onNoMatch: ResultAction,
  /** Rules in one group are exclusive: the matching rule with the lowest priority wins. */
  group: Schema.NullOr(RuleGroup),
  priority: Schema.Int,
  enabled: Schema.Boolean,
}).annotate({ identifier: "RuleBinding" })
export type RuleBinding = typeof RuleBinding.Type

export const RuleOutcome = Schema.Struct({
  ruleId: RuleId,
  outcome: Outcome,
  /** True when the rule requests presence and won its group, or has no group. */
  selected: Schema.Boolean,
  /** Absent in activity recorded before configurable result actions. */
  requestedAction: Schema.optionalKey(ResultAction),
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
 * 1. Rules requesting presence are candidates; the lowest group priority wins.
 * 2. A selected rule wants its label present.
 * 3. Each conclusive result uses its configured action. Losing presence requests
 *    retain the legacy group removal behavior until group exclusivity is migrated.
 * 4. Unknown and failed preserve the label and block their entire group.
 *    Not-applicable wants nothing without blocking its group.
 * 5. Per label, present beats absent.
 */
export const plan = ({ rules, outcomes, currentLabels }: PlanInput): Plan => {
  const enabled = rules.filter((rule) => rule.enabled)
  const blockedGroups = new Set(
    enabled
      .filter((rule) => {
        const outcome = outcomes.get(rule.id) ?? "unknown"
        return rule.group !== null && (outcome === "unknown" || outcome === "failed")
      })
      .map((rule) => rule.group),
  )
  // Legacy configurations can share label ownership. Protect the label itself,
  // including disabled members' labels in a blocked group, from every rule.
  const protectedLabels = new Set(
    rules
      .filter((rule) => {
        const outcome = outcomes.get(rule.id) ?? "unknown"
        return (
          (rule.group !== null && blockedGroups.has(rule.group)) ||
          (rule.enabled && (outcome === "unknown" || outcome === "failed"))
        )
      })
      .map((rule) => rule.labelId),
  )
  const winners = new Map<string, RuleId>()
  for (const rule of enabled) {
    if (
      rule.group === null ||
      protectedLabels.has(rule.labelId) ||
      resultAction(rule, outcomes.get(rule.id) ?? "unknown") !== "ensure-present"
    )
      continue
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
    if (protectedLabels.has(rule.labelId)) {
      ruleOutcomes.push({ ruleId: rule.id, outcome, selected: false, requestedAction: "no-action" })
      continue
    }
    const won = rule.group === null || winners.get(rule.group) === rule.id
    const action = resultAction(rule, outcome)
    const selected = action === "ensure-present" && won
    if (selected) {
      ruleOutcomes.push({ ruleId: rule.id, outcome, selected, requestedAction: "ensure-present" })
      if (!wantPresent.has(rule.labelId)) wantPresent.set(rule.labelId, rule.id)
      continue
    }
    const remove =
      action === "ensure-absent" ||
      (action === "ensure-present" && !won && rule.onNoMatch === "ensure-absent")
    ruleOutcomes.push({
      ruleId: rule.id,
      outcome,
      selected,
      requestedAction: remove ? "ensure-absent" : "no-action",
    })
    if (remove && !wantAbsent.has(rule.labelId)) {
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
