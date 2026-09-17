# Run Slack sessions in the API Worker

Status: accepted.

This supersedes ADRs 0001 through 0004 for new Slack sessions. The priority is an unattended Cloudflare bot that can converse, ask follow-up questions and inspect a repository.

## Decision

The API Worker hosts one Durable Object per Slack workspace, channel and root message timestamp. Signed Slack events are authorized against linked Janitor teammates and private-channel membership before admission. Admission persists the input and schedules an alarm, then acknowledges Slack. The object serializes turns and deduplicates recent message timestamps, including duplicate message and app-mention deliveries.

The object runs Effect Chat against OpenRouter. A clarification question is a normal reply ending the turn; a later human reply continues the stored conversation. Each turn has at most twelve model calls and a five-minute timeout. The model is configured independently of the labeling classifier.

Turns stream model responses into small execution observations, following Alchemy's AI.Events design. Assistant text accompanying tool calls becomes a conversational Slack reply while work continues. Reasoning and raw tool output stay internal. A separate presenter posts one activity message per turn and edits it with the current activity, elapsed seconds and completed tool-call count, at most once every three seconds during execution. Normal completion or failure makes a final status edit. Presentation failures are logged without retrying ambiguous sends or replaying agent work. Status is best-effort: abrupt Worker eviction can leave the activity message stale; the existing interrupted-turn reply remains authoritative.

Messages arriving during work still queue for subsequent turns. Authorship is retained, and model guidance asks teammates to resolve conflicting instructions. Existing threads receive updated system guidance while retaining their conversation history.

Repository selection is optional until a tool needs it. A thread selects one connected repository and ref. GitHub App credentials are minted with read-only contents permission for that repository. A lazily started Node container provides Git, filesystem and shell operations through `packages/alchemy`. Separate threads have separate checkouts.

Conversation history, repository selection, queued inputs and recent delivery identities live in Durable Object storage. Container files are ephemeral. Replacement can lose unpublished edits; the next repository operation can re-clone. An interrupted turn is reported without replaying model or tool execution, then later inputs can proceed. There are no workspace backups or Retry/Skip protocol in this path.

The root stack no longer deploys the separate runner. Old runner modules and database-backed observations remain historical code; new sessions do not appear in that dashboard or consume GitHub review feedback. Existing runner resources and session data require an explicit deployment cutover. Deploying and changing live Slack configuration require user approval.

## Configuration and validation

- `JANITOR_CHAT_MODEL` selects the OpenRouter model. Its default is `z-ai/glm-5.3-flash`.
- `JANITOR_AGENT_RUNNER_MODEL_API_KEY` supplies the OpenRouter credential using the existing secret name.
- Existing Slack workspace, app, bot token, signing secret and account-linking configuration remain required.
- The webhook path remains `/api/v1/webhooks/slack`. Subscribe to app mentions and private-channel messages so ordinary thread replies reach the session.

Local tests cover admission, duplicate delivery, queued inputs, interruption and conversational tool use. A deployed smoke test must still verify Alchemy's container attachment, image startup, OpenRouter tool support, a private repository clone and a follow-up Slack reply.
