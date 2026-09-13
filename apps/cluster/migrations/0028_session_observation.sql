-- Session observation: one team-wide live channel for the dashboard.
--
-- Session projections are not owned by a repository, so their invalidation
-- intent is keyed by the reserved channel 'sessions' rather than a repository
-- id. Rows commit with the change that caused them; the dispatcher forwards
-- them after commit and clients refresh their HTTP reads. Membership changes
-- use the same channel so an open subscription of a removed teammate closes.
CREATE FUNCTION enqueue_session_notification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- The projection's freshness_at is a heartbeat; the dashboard shows the
  -- catch-up obligation's last read instead, which has its own trigger.
  IF TG_OP = 'UPDATE' AND (to_jsonb(OLD) - 'freshness_at') = (to_jsonb(NEW) - 'freshness_at') THEN RETURN NULL; END IF;
  INSERT INTO live_notification(repository_id,topic) VALUES('sessions',TG_ARGV[0])
    ON CONFLICT(repository_id,topic) DO UPDATE SET revision=nextval('live_notification_revision');
  RETURN NULL;
END $$;

CREATE TRIGGER live_session_projection AFTER INSERT OR UPDATE OR DELETE ON agent_session_projection
  FOR EACH ROW EXECUTE FUNCTION enqueue_session_notification('sessions');
CREATE TRIGGER live_session_freshness AFTER UPDATE OF last_read_at, last_error ON agent_catchup
  FOR EACH ROW EXECUTE FUNCTION enqueue_session_notification('sessions');
CREATE TRIGGER live_session AFTER INSERT OR UPDATE OF title, repository_id, runner_state, runner_error OR DELETE ON agent_session
  FOR EACH ROW EXECUTE FUNCTION enqueue_session_notification('sessions');
-- Delivery health and associations live on the thread; cursors and leases are bookkeeping.
CREATE TRIGGER live_session_thread AFTER INSERT OR UPDATE OF repository_id, pr_number, state, warning, delivery_warning OR DELETE ON slack_thread
  FOR EACH ROW EXECUTE FUNCTION enqueue_session_notification('sessions');
CREATE TRIGGER live_session_github_output AFTER INSERT OR UPDATE OF state, error OR DELETE ON github_feedback_output
  FOR EACH ROW EXECUTE FUNCTION enqueue_session_notification('sessions');
CREATE TRIGGER live_membership AFTER UPDATE OF status ON teammate
  FOR EACH ROW EXECUTE FUNCTION enqueue_session_notification('membership');
