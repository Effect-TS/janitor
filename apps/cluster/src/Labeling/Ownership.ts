import type { GitHubLabelDatabaseId, GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { RuleId } from "@janitor/domain/Labeling/Policy/Plan"
import type { PolicyTarget } from "@janitor/domain/Labeling/Policy/Program"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type * as SqlClient from "effect/unstable/sql/SqlClient"

/** Call under withRepositoryMutation so checking and writing share the repository lock. */
export const labelOwnershipConflict = (
  sql: SqlClient.SqlClient,
  repositoryId: GitHubRepositoryDatabaseId,
  labelId: GitHubLabelDatabaseId,
  target: PolicyTarget,
  excludingRuleId?: RuleId,
) =>
  sql`
    SELECT r.rule_id, r.enabled FROM labeling_rule r
    JOIN labeling_policy p ON p.policy_id = r.policy_id
    JOIN labeling_policy_version v ON v.version_id = p.published_version_id
    WHERE r.repository_id = ${repositoryId} AND r.label_id = ${labelId}
      AND v.program->>'target' = ${target}
      AND r.rule_id <> ${excludingRuleId ?? ""}
    ORDER BY r.rule_id LIMIT 1
  `.pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ rule_id: RuleId, enabled: Schema.Boolean })),
      ),
    ),
    Effect.map((owners) => {
      const owner = owners[0]
      return owner === undefined
        ? undefined
        : `Label ${labelId} is already owned for ${target === "issue" ? "issues" : "pull requests"} by ${owner.enabled ? "rule" : "disabled rule"} ${owner.rule_id}. Edit or delete that rule, or choose another label. Disabling a rule retains ownership.`
    }),
  )
