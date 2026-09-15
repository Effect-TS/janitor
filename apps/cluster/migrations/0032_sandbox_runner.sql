-- The sandbox runner cutover.
--
-- Agent sessions now run in a sandbox-owning Durable Object that preserves
-- completed turns and waits for a teammate's explicit Retry or Skip after an
-- interruption. The maintenance barrier and its per-session holds, which
-- assumed deployment draining and native automatic resumption, are retired.
--
-- Cutover starts fresh: every existing session ends here. Its runner object is
-- retired through the ordinary cleanup tombstone, its pending handoffs are
-- dropped so no delayed delivery can resurrect it, and its Slack thread is
-- forgotten so later messages in that thread cannot revive the identity.
-- Published GitHub work, repository connections and every other record stay.

DROP TABLE IF EXISTS agent_session_maintenance;
DROP TABLE IF EXISTS agent_maintenance;

-- Retry/Skip buttons ride on the interruption message; the runner deduplicates clicks.
ALTER TABLE slack_output ADD COLUMN actions JSONB;

-- Conversation-only sessions have no repository but still own a runner object.
ALTER TABLE agent_session_cleanup ALTER COLUMN repository_id DROP NOT NULL;

INSERT INTO agent_session_cleanup (session_id, repository_id, generation, native_session_id)
SELECT session_id, repository_id, generation, native_session_id FROM agent_session
ON CONFLICT (session_id) DO NOTHING;
DELETE FROM workflow_outbox
WHERE workflow_tag = 'Janitor/AgentRunnerHandoffV1'
  AND payload->>'sessionId' IN (SELECT session_id FROM agent_session);
DELETE FROM slack_thread WHERE session_id IN (SELECT session_id FROM agent_session);
DELETE FROM agent_session;
