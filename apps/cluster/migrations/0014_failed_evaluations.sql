-- Evaluation errors are independent of label-write failures. Keep historical results intact.
ALTER TABLE labeling_rule_evaluation
  DROP CONSTRAINT labeling_rule_evaluation_outcome_check,
  ADD CONSTRAINT labeling_rule_evaluation_outcome_check
    CHECK (outcome IN ('match', 'no-match', 'unknown', 'not-applicable', 'failed'));
