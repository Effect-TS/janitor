-- Existing rules add on match. Preserve becomes the explicit no-action result.
ALTER TABLE labeling_rule DROP CONSTRAINT ai_preserve;
ALTER TABLE labeling_rule DROP CONSTRAINT labeling_rule_on_no_match_check;
ALTER TABLE labeling_rule ADD COLUMN on_match TEXT NOT NULL DEFAULT 'ensure-present'
  CHECK (on_match IN ('ensure-present', 'ensure-absent', 'no-action'));
UPDATE labeling_rule SET on_no_match = 'no-action' WHERE on_no_match = 'preserve';
ALTER TABLE labeling_rule ADD CONSTRAINT labeling_rule_on_no_match_check
  CHECK (on_no_match IN ('ensure-present', 'ensure-absent', 'no-action'));

-- Retain revisions and all other snapshot fields, including empty configurations.
UPDATE labeling_configuration c SET rules = (
  SELECT coalesce(jsonb_agg(
    rule || jsonb_build_object(
      'onMatch', 'ensure-present',
      'onNoMatch', CASE WHEN rule->>'onNoMatch' = 'preserve'
        THEN 'no-action' ELSE rule->>'onNoMatch' END
    ) ORDER BY ordinal
  ), '[]'::jsonb)
  FROM jsonb_array_elements(c.rules) WITH ORDINALITY AS entries(rule, ordinal)
);
