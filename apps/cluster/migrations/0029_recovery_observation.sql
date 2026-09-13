-- Recovery health on the sessions live channel.
--
-- The dashboard states when each platform's recovery scan last completed,
-- whether it is overdue or incomplete, what it is retrying past, and what it
-- can never bring back. Those facts change when a scan completes, records a
-- warning or gap, or captures a retained payload, and when feedback hydration
-- changes state. Scan cursors, due times and leases are bookkeeping and stay
-- silent: the scans write them together with health columns on every page,
-- so each trigger fires only when a health column actually changed. Time-based
-- lateness has no trigger; the dashboard's fallback refresh picks it up.
CREATE TRIGGER live_session_recovery AFTER UPDATE ON platform_recovery
  FOR EACH ROW WHEN (OLD.completed_at IS DISTINCT FROM NEW.completed_at
    OR OLD.warning IS DISTINCT FROM NEW.warning OR OLD.gap IS DISTINCT FROM NEW.gap)
  EXECUTE FUNCTION enqueue_session_notification('sessions');
CREATE TRIGGER live_session_recovery_attempt AFTER INSERT OR DELETE ON github_recovery_attempt
  FOR EACH ROW EXECUTE FUNCTION enqueue_session_notification('sessions');
CREATE TRIGGER live_session_recovery_attempt_state AFTER UPDATE ON github_recovery_attempt
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION enqueue_session_notification('sessions');
CREATE TRIGGER live_session_thread_recovery AFTER UPDATE ON slack_thread
  FOR EACH ROW WHEN (OLD.recovery_completed_at IS DISTINCT FROM NEW.recovery_completed_at
    OR OLD.recovery_warning IS DISTINCT FROM NEW.recovery_warning)
  EXECUTE FUNCTION enqueue_session_notification('sessions');
CREATE TRIGGER live_session_feedback AFTER INSERT OR DELETE ON github_feedback
  FOR EACH ROW EXECUTE FUNCTION enqueue_session_notification('sessions');
CREATE TRIGGER live_session_feedback_state AFTER UPDATE ON github_feedback
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state OR OLD.warning IS DISTINCT FROM NEW.warning)
  EXECUTE FUNCTION enqueue_session_notification('sessions');
