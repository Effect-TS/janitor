-- The web app refreshes the PR review panel and the runs list on the `review`
-- live topic, as Activity does on `activity`. Issue review used the same topic
-- until 0054 removed it. Findings are written with their run, so the run row
-- covers them.
CREATE TRIGGER live_pr_review_setting AFTER INSERT OR UPDATE OR DELETE ON pr_review_repository
FOR EACH ROW EXECUTE FUNCTION enqueue_live_notification('review');
CREATE TRIGGER live_pr_review_run AFTER INSERT OR UPDATE OR DELETE ON pr_review_runs
FOR EACH ROW EXECUTE FUNCTION enqueue_live_notification('review');
