# Private Slack conversations

Start with [app-manifest.json](app-manifest.json), replacing `YOUR_JANITOR_HOST` with the deployment hostname. Merge these bot settings into the app used for account linking. User OpenID Connect grants remain separate from bot grants. Reinstall the app after changing scopes and invite its bot to each private channel that will host conversations.

## Configuration

Set `JANITOR_SLACK_WORKSPACE_ID`, `JANITOR_SLACK_APP_ID`, `JANITOR_SLACK_BOT_USER_ID`, `JANITOR_SLACK_BOT_TOKEN` and `JANITOR_SLACK_SIGNING_SECRET`. The workspace must also appear in the account-linking `JANITOR_SLACK_WORKSPACE_IDS` allowlist.

Set `JANITOR_AGENT_RUNNER_MODEL_API_KEY` to an OpenRouter credential. `JANITOR_CHAT_MODEL` defaults to `z-ai/glm-5.3-flash`, independently of the labeling model.

Event Subscriptions points to `/api/v1/webhooks/slack` and subscribes to `app_mention` and `message.groups`. The handler verifies the raw request signature and timestamp. It authorizes linked teammates, checks private-channel membership, and acknowledges after the session object persists the input. The route has a 2.5-second deadline and returns a retryable failure if admission cannot finish in time.

## Conversation behavior

Teammates sign in to Janitor and connect their Slack accounts. Mention the bot to start a conversation. Janitor can converse before selecting a repository; repository tools require one connected, ready repository and ref. Ordinary thread replies continue the conversation. Replies arriving during work queue for subsequent turns.

The agent posts commentary while tools run. One separate activity message per turn shows current activity, elapsed time and completed actions, with updates at most once every three seconds. Final answers are conversational replies. Questions end the turn and wait for a teammate's response.

Conversation history and queued inputs live in Durable Object storage. Container files are ephemeral. An interrupted turn is reported without replaying its tools, then later inputs can proceed. Presentation failures are logged without retrying ambiguous sends. Abrupt Worker eviction can leave an activity message stale.

The former Retry/Skip buttons, GitHub review-feedback processing and database-backed session dashboard have been retired. Disable Interactivity in existing Slack installations that still point to the former endpoint.

## Validation

Run `vp test apps/cluster/test/Slack` for signed admission, queueing, model/tool streaming, repository access and presentation tests.

A deployed smoke test should verify a mention, repository inspection, commentary during work, the editable activity message, and an ordinary teammate reply during execution that runs on the following turn. See [ADR 0005](../adr/0005-slack-sessions-in-the-api-worker.md) for the runtime design.
