import type { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import type { RuleIssue } from "@janitor/domain/Labeling/Policy/Configuration"
import type { RuleId } from "@janitor/domain/Labeling/Policy/Plan"
import type { PolicyTarget } from "@janitor/domain/Labeling/Policy/Program"
import type { PolicyId } from "@janitor/domain/Labeling/Policy/Condition"
import * as Effect from "effect/Effect"
import type * as SqlClient from "effect/unstable/sql/SqlClient"

/** Membership uses published targets and includes disabled rules. Call under the repository lock. */
export const groupIssues = Effect.fn("groupIssues")(function* (
  sql: SqlClient.SqlClient,
  repositoryId: GitHubRepositoryDatabaseId,
  group: string | null,
  target: PolicyTarget,
  priority: number,
  excludingRuleId?: RuleId,
  changingPolicyId?: PolicyId,
) {
  if (group === null) return []
  const members = yield* sql<{
    rule_id: string
    priority: number
    target: string
    policy_id: string
  }>`
    SELECT r.rule_id, r.priority, r.policy_id, v.program->>'target' AS target
    FROM labeling_rule r
    JOIN labeling_policy p ON p.policy_id = r.policy_id
    JOIN labeling_policy_version v ON v.version_id = p.published_version_id
    WHERE r.repository_id = ${repositoryId} AND r.rule_group = ${group}
      AND r.rule_id <> ${excludingRuleId ?? ""}
    ORDER BY r.rule_id
  `
  const issues: Array<RuleIssue> = []
  for (const member of members) {
    if (member.target !== target && member.policy_id !== changingPolicyId)
      issues.push({
        code: "group-target-mismatch",
        message: `Labeling group '${group}' targets ${member.target}. Rule ${member.rule_id} reserves that target, even when disabled. Choose another group or remove its members before changing target.`,
      })
    if (member.priority === priority)
      issues.push({
        code: "duplicate-priority",
        message: `Priority ${priority} in labeling group '${group}' is reserved by rule ${member.rule_id}, even when disabled. Choose another priority or reorder the group.`,
      })
  }
  return issues
})
