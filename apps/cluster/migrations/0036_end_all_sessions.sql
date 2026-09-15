-- End every existing agent session.
--
-- The sessions created while the sandbox runner was being brought up carry
-- failed first turns and a runner protocol two versions old. Each one ends
-- here the way the cutover ended its predecessors: its runner object is
-- retired through the ordinary cleanup tombstone, its pending handoffs are
-- dropped so no delayed delivery can resurrect it, and its Slack thread is
-- forgotten so later messages in that thread cannot revive the identity.
-- Published GitHub work, repository connections and every other record stay.
-- New sessions start from new threads.

INSERT INTO agent_session_cleanup (session_id, repository_id, generation, native_session_id)
SELECT session_id, repository_id, generation, native_session_id FROM agent_session
ON CONFLICT (session_id) DO NOTHING;
DELETE FROM workflow_outbox
WHERE workflow_tag = 'Janitor/AgentRunnerHandoffV1'
  AND payload->>'sessionId' IN (SELECT session_id FROM agent_session);
DELETE FROM slack_thread WHERE session_id IN (SELECT session_id FROM agent_session);
DELETE FROM agent_session;
