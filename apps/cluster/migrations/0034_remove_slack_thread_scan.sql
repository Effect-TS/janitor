-- Remove the Slack thread scan.
--
-- Slack messages arrive by event only; Slack retries a failed delivery on its
-- own. The scan that re-read every ready thread every five minutes to catch
-- messages whose events never arrived is gone, together with its bookkeeping
-- columns and live trigger. The delivery warning column stays: delivery
-- writes it and the dashboard reads it.
DROP TRIGGER IF EXISTS live_session_thread_recovery ON slack_thread;
ALTER TABLE slack_thread
  DROP COLUMN IF EXISTS recovery_cursor,
  DROP COLUMN IF EXISTS recovery_oldest,
  DROP COLUMN IF EXISTS recovery_highwater,
  DROP COLUMN IF EXISTS recovery_due_at,
  DROP COLUMN IF EXISTS recovery_completed_at,
  DROP COLUMN IF EXISTS recovery_lease_until,
  DROP COLUMN IF EXISTS recovery_lease_token,
  DROP COLUMN IF EXISTS recovery_warning;
