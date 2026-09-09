-- Preflight for service-enforced ownership. Configuration writes serialize on
-- the github_repository row before checking the current published targets.
-- Stop old workers before applying this migration and starting the new release.
DO $$
DECLARE
  conflicts TEXT;
BEGIN
  LOCK TABLE labeling_rule, labeling_policy, labeling_policy_version IN SHARE MODE;
  SELECT string_agg(
    format('repository=%s label=%s target=%s rules=[%s]', repository_id, label_id, target, rule_ids),
    E'\n' ORDER BY repository_id, label_id, target
  ) INTO conflicts
  FROM (
    SELECT r.repository_id, r.label_id, v.program->>'target' AS target,
      string_agg(r.rule_id, ', ' ORDER BY r.rule_id) AS rule_ids
    FROM labeling_rule r
    JOIN labeling_policy p ON p.policy_id = r.policy_id
    JOIN labeling_policy_version v ON v.version_id = p.published_version_id
    GROUP BY r.repository_id, r.label_id, v.program->>'target'
    HAVING count(*) > 1
  ) duplicates;
  IF conflicts IS NOT NULL THEN
    RAISE EXCEPTION E'Label ownership conflicts. Edit or delete the conflicting rules before retrying this migration. Disabled rules retain ownership.\n%', conflicts;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS labeling_rule_label_idx ON labeling_rule (repository_id, label_id);
