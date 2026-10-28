# Operating the chat bot

The chat bot is a team agent people talk to from Slack and, later, Discord. Each thread is a chat session: mention the bot to start one, and it runs clanka in a chat sandbox with access to every repository in Effect-TS and Effectful-Tech. ADR 0014 records the design, and `CONTEXT.md` defines the terms.

The bot is off for the whole deployment until `CHAT_AI_API_URL` and `CHAT_AI_API_KEY` are set. Each platform is also off until its own settings are set.

## Slack

### What it does

- A mention of the bot from an admitted user starts a session on the thread under the mention. When the bot joins a thread that already has messages, it reads the last 100 as context.
- In a thread with a session, every message from an admitted user reaches the session, and the reply gate decides whether it is meant for the bot. A message that mentions the bot always starts or steers a turn.
- Admitted users are full members of our workspace: `users.info` reports our `team_id`, and none of `is_restricted`, `is_ultra_restricted`, `is_stranger`, `deleted` or `is_bot`. Guests, Slack Connect users and strangers are outsiders. Their messages in a thread with a session reach the model as context only, and their mentions start nothing. A failed lookup also makes the author an outsider. An admission is remembered in the session for an hour.
- Messages from bots, janitor's own included, are context only. Edits, deletions and other message subtypes are ignored, except messages with files and thread replies also sent to the channel.
- In a Slack Connect channel the bot replies once that it doesn't work there, and starts nothing.
- Replies are posted as Markdown, up to 12,000 characters a message and a second apart. A reply that would need more than three messages is uploaded as `reply.md`. The bot's posts never unfurl links, and they carry `janitor_output` message metadata.

### Creating the Slack app

Create one app for production and one for development, each in our workspace.

1. Under **OAuth & Permissions**, add these bot token scopes: `app_mentions:read`, `channels:history`, `groups:history`, `channels:read`, `groups:read`, `users:read`, `chat:write`, `files:read` and `files:write`.
2. Under **Event Subscriptions**, turn events on and set the request URL to `https://<janitor host>/api/v1/webhooks/slack`. Slack sends a `url_verification` challenge, which the route answers only once the deployment has the Slack settings below. Subscribe to the bot events `app_mention`, `message.channels` and `message.groups`.
3. Leave **Interactivity** and **Socket Mode** off.
4. Install the app to the workspace.

The app doesn't subscribe to `message.im`, so Slack never sends it direct messages. If it ever does, the bot answers with a one-line pointer to a channel.

### Settings

Slack is on once all four of these are set, and off while any of them is missing. They live in Infisical, in the `janitor` project.

| Setting                | Where to find it                                               |
| ---------------------- | -------------------------------------------------------------- |
| `SLACK_SIGNING_SECRET` | **Basic Information**, **Signing Secret**                      |
| `SLACK_BOT_TOKEN`      | **OAuth & Permissions**, **Bot User OAuth Token** (`xoxb-...`) |
| `SLACK_WORKSPACE_ID`   | The workspace's team id (`T...`), the `team_id` events carry   |
| `SLACK_APP_ID`         | **Basic Information**, **App ID** (`A...`)                     |

The webhook path skips Cloudflare Access, like GitHub's, and relies on the signature: an HMAC-SHA-256 of `v0:{timestamp}:{body}` with the signing secret, within 300 seconds of the request's timestamp. Each event's `team_id` and `api_app_id` must match the settings. The route answers within 2.5 seconds, or answers 503 so Slack delivers the event again, and sessions ignore a message they already have.

### Inviting the bot

The bot only hears channels it is a member of. In a channel, type `/invite @janitor` (or the app's display name). Roll out to one private core-team channel first, and to public channels once the smoke test passes.

### Development

The development stack's `janitor-dev` tunnel forwards `/api/v1/webhooks/slack` to the local Worker, next to the GitHub webhook. Point the development app's request URL at the tunnel's hostname, and keep it in a test channel.
