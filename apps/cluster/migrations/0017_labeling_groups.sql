-- Stop old workers before migration. Every configuration write in the new
-- release checks membership under the repository lock.
DO $$
DECLARE conflicts TEXT;
BEGIN
  LOCK TABLE labeling_rule, labeling_policy, labeling_policy_version, labeling_configuration IN SHARE ROW EXCLUSIVE MODE;
  SELECT string_agg(format('repository=%s group=%s rules=[%s] targets=[%s] priorities=[%s]',
    repository_id, rule_group, ids, targets, priorities), E'\n') INTO conflicts
  FROM (
    SELECT r.repository_id, r.rule_group,
      string_agg(r.rule_id, ', ' ORDER BY r.rule_id) AS ids,
      string_agg(DISTINCT v.program->>'target', ', ') AS targets,
      string_agg(r.priority::text, ', ' ORDER BY r.rule_id) AS priorities
    FROM labeling_rule r
    JOIN labeling_policy p ON p.policy_id = r.policy_id
    JOIN labeling_policy_version v ON v.version_id = p.published_version_id
    WHERE r.rule_group IS NOT NULL
    GROUP BY r.repository_id, r.rule_group
    HAVING count(DISTINCT v.program->>'target') > 1 OR count(DISTINCT r.priority) <> count(*)
  ) invalid;
  IF conflicts IS NOT NULL THEN
    RAISE EXCEPTION E'Labeling group target or priority conflicts. Split mixed-target groups and assign unique priorities, including disabled members, before retrying. Lower numbers still win until migration.\n%', conflicts;
  END IF;

  -- Invert the full signed integer range without overflow, preserving order.
  UPDATE labeling_rule SET priority = (-priority::bigint - 1)::integer,
    version = version + 1, updated_at = CLOCK_TIMESTAMP()
  WHERE rule_group IS NOT NULL;

  -- A new revision fences pending evaluations computed with legacy semantics.
  -- Retain historical configurations, evaluation results, and actions unchanged.
  CREATE TEMP TABLE labeling_group_revisions ON COMMIT DROP AS
    SELECT pointer.repository_id, pointer.configured_revision AS previous_revision,
      pointer.configured_revision + 1 AS next_revision
    FROM labeling_repository_rules pointer
    WHERE EXISTS (SELECT 1 FROM labeling_rule r WHERE r.repository_id = pointer.repository_id AND r.rule_group IS NOT NULL);
  INSERT INTO labeling_configuration
    (repository_id, revision, rules, version_ids, required_tracks, preparation, actor_issuer, actor_subject)
    SELECT c.repository_id, mapped.next_revision, c.rules, c.version_ids, c.required_tracks,
      c.preparation, 'migration', '0017_labeling_groups'
    FROM labeling_configuration c JOIN labeling_group_revisions mapped
      ON c.repository_id = mapped.repository_id AND c.revision = mapped.previous_revision;

  UPDATE labeling_configuration c SET rules = COALESCE((
    SELECT jsonb_agg(CASE WHEN rule->>'group' IS NULL THEN rule
      ELSE jsonb_set(rule, '{priority}', to_jsonb(-(rule->>'priority')::bigint - 1)) END ORDER BY ordinal)
    FROM jsonb_array_elements(c.rules) WITH ORDINALITY AS members(rule, ordinal)
  ), '[]'::jsonb)
  WHERE EXISTS (SELECT 1 FROM labeling_group_revisions mapped WHERE mapped.repository_id = c.repository_id AND mapped.next_revision = c.revision);

  -- The current snapshots need labels reserved by disabled group members.
  -- Their policy versions are not evaluated and need no additional fact tracks.
  UPDATE labeling_configuration c SET rules = c.rules || COALESCE((
    SELECT jsonb_agg(jsonb_build_object('id', r.rule_id, 'labelId', r.label_id,
      'policyId', r.policy_id, 'policyVersionId', p.published_version_id,
      'onMatch', r.on_match, 'onNoMatch', r.on_no_match, 'group', r.rule_group,
      'priority', r.priority, 'enabled', false) ORDER BY r.created_at, r.rule_id)
    FROM labeling_rule r JOIN labeling_policy p ON p.policy_id = r.policy_id
    WHERE r.repository_id = c.repository_id AND NOT r.enabled AND r.rule_group IS NOT NULL
      AND r.label_status = 'valid' AND p.published_version_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(c.rules) member WHERE member->>'id' = r.rule_id)
  ), '[]'::jsonb)
  WHERE EXISTS (SELECT 1 FROM labeling_group_revisions mapped WHERE mapped.repository_id = c.repository_id AND mapped.next_revision = c.revision);

  UPDATE labeling_configuration c SET version_ids = (
    SELECT jsonb_agg(DISTINCT version_id) FROM (
      SELECT value AS version_id FROM jsonb_array_elements(c.version_ids)
      UNION SELECT rule->'policyVersionId' FROM jsonb_array_elements(c.rules) rule
    ) versions
  ) WHERE EXISTS (SELECT 1 FROM labeling_group_revisions mapped WHERE mapped.repository_id = c.repository_id AND mapped.next_revision = c.revision);

  UPDATE labeling_repository_rules pointer SET configured_revision = mapped.next_revision,
    active_revision = CASE WHEN pointer.active_revision = mapped.previous_revision THEN mapped.next_revision ELSE pointer.active_revision END,
    updated_at = CLOCK_TIMESTAMP()
  FROM labeling_group_revisions mapped WHERE pointer.repository_id = mapped.repository_id;
END $$;

CREATE INDEX IF NOT EXISTS labeling_rule_group_idx ON labeling_rule(repository_id, rule_group);
