-- Normal startup is event-driven. Due times are continuation/recovery obligations.
ALTER TABLE slack_thread
  ADD COLUMN input_revision BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN startup_phase TEXT NOT NULL DEFAULT 'preparing'
    CHECK (startup_phase IN ('preparing','selecting','history','clarification','repository','runner','ready','retry','failed')),
  ADD COLUMN selection_reason TEXT,
  ADD COLUMN inference_key TEXT,
  ADD COLUMN inference_result JSONB,
  ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN retry_not_before TIMESTAMPTZ;

CREATE TRIGGER live_session_startup AFTER UPDATE OF startup_phase ON slack_thread
  FOR EACH ROW EXECUTE FUNCTION enqueue_session_notification('sessions');

-- Readiness changes only wake waiting sessions; they do not poll Slack while idle.
CREATE FUNCTION wake_slack_repository() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD IS DISTINCT FROM NEW THEN
    UPDATE slack_thread SET due_at = CLOCK_TIMESTAMP(), input_revision = input_revision + 1
      WHERE repository_id = NEW.repository_id AND startup_phase = 'repository' AND state <> 'redirected';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER slack_repository_ready AFTER UPDATE OF connected, enabled, access, automation_ready_at
  ON github_repository FOR EACH ROW EXECUTE FUNCTION wake_slack_repository();

-- Adopt existing initialization and buffered replies without resetting history or identity.
UPDATE slack_thread t SET startup_phase = CASE WHEN state='ready' THEN 'ready' ELSE 'preparing' END,
  due_at = CASE WHEN state='initializing' OR EXISTS (
    SELECT 1 FROM slack_contribution c WHERE c.workspace_id=t.workspace_id AND c.channel_id=t.channel_id
      AND c.thread_ts=t.thread_ts AND c.message_ts::numeric>=t.boundary_ts::numeric
      AND c.decision='accepted' AND NOT c.forwarded
  ) THEN CLOCK_TIMESTAMP() ELSE 'infinity'::timestamptz END;
INSERT INTO workflow_outbox(workflow_tag,execution_key,payload)
  SELECT 'Janitor/SlackProcessingV1',session_id || ':' || input_revision::text,
    jsonb_build_object('sessionId',session_id,'revision',input_revision::text)
  FROM slack_thread WHERE state<>'redirected' AND due_at<>'infinity'::timestamptz
  ON CONFLICT(workflow_tag,execution_key) DO NOTHING;
