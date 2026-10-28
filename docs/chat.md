# Operating the chat bot

The chat bot is a team agent people talk to from Slack and, later, Discord. Each thread is a chat session: mention the bot to start one, and it runs clanka in a chat sandbox with access to every repository in Effect-TS and Effectful-Tech. ADR 0014 records the design, and `CONTEXT.md` defines the terms.

The bot is off for the whole deployment until `CHAT_AI_API_URL` and `CHAT_AI_API_KEY` are set. Each platform is also off until its own settings are set. While the bot or a platform is off, its settings aren't read and nothing is bound, so a deploy can go out before any secret exists.

## What it does

- A mention of the bot starts a session on its thread, and the session's first turn. When the bot joins a thread that already has messages, it reads the last 100 as context.
- In a thread with a session, the reply gate decides whether a message without a mention is meant for the bot. It asks Jev, with the last 20 messages as context, and a message passes at a probability of one half or more. A mention always skips the gate.
- A message that passes while a turn is running steers it: the model sees it between its steps. A message that is only "stop" stops the running turn before any model sees it.
- Each turn runs clanka in a chat sandbox, a container of its own class so chat can't starve PR review. Nothing is checked out up front: the model clones what it needs into `/workspace/<org>/<repo>`. It can push to any branch except protected ones, open and merge pull requests, and use the `multica` CLI as the Janitor member, for example to hand larger work to a squad as an issue. The egress proxy adds the credentials; the sandbox holds none.
- The thread gets a status message that the bot edits as the turn goes, with a link to the session's transcript, and then the reply. A plain reply ends the turn.
- After a turn, the sandbox stays warm for 30 minutes, so a follow-up finds its clones and edits. Durable work is pushed work: anything not pushed is gone once the sandbox is.
- A turn that loses its sandbox, or is cut off by a restart, resumes on a fresh one, up to three times. The model is told the sandbox is new and to check what it already pushed, opened or commented before redoing a step.
- At 17 minutes the turn is told to wrap up, and at 20 it stops. Time spent waiting for a sandbox doesn't count. When all 10 sandboxes are running turns, a turn waits in one queue shared by every platform, and gives up after 15 minutes with a message that the bot is busy.
- When the model provider fails once clanka's retries run out (quota, auth, 5xx), the turn ends, and the status message gives the error's category.
- A session expires 30 days after its last message, and its storage and transcript go with it. A later message starts a new session with a fresh backfill.

### Limits

| Setting                        | Default | Meaning                                                                |
| ------------------------------ | ------- | ---------------------------------------------------------------------- |
| `CHAT_TURN_DEADLINE_SECONDS`   | 1200    | A turn's hard deadline, from its start and across resumes              |
| `CHAT_WRAP_UP_AFTER_SECONDS`   | 1020    | When a turn is told to wrap up, from its start                         |
| `CHAT_COMMAND_TIMEOUT_SECONDS` | 300     | The longest one `bash` command or `execute` script may run             |
| `CHAT_MAX_RESUMES`             | 3       | How often one turn may resume after a lost sandbox or a restart        |
| `CHAT_SANDBOX_WARM_SECONDS`    | 1800    | How long a session's sandbox stays warm after its turn                 |
| `CHAT_QUEUE_TIMEOUT_SECONDS`   | 900     | How long a turn waits for a sandbox before giving up as busy           |
| `CHAT_SESSION_RETENTION_DAYS`  | 30      | How long a session, and its transcript, is kept after its last message |
| `CHAT_SANDBOX_MAX_INSTANCES`   | 10      | How many chat sandboxes may run at once                                |

`CHAT_SANDBOX_MAX_INSTANCES` sets the container application's `max_instances`, and `CHAT_COMMAND_TIMEOUT_SECONDS` is baked into the sandbox image, so both need a deploy to change.

## Deployment setup

### Model and credit limit

Turns call an OpenAI-compatible chat completions endpoint, the same mechanism as PR review's with a key of its own. Set `CHAT_AI_API_URL` to the endpoint's base URL, the part before `/chat/completions`, and `CHAT_AI_API_KEY` to its key, both in Infisical (project `janitor`). Without both, the bot is off.

| Setting                    | Default              | Meaning                                                                                |
| -------------------------- | -------------------- | -------------------------------------------------------------------------------------- |
| `CHAT_AI_MODEL`            | `openai/gpt-6.1-sol` | The model turns run on, as the endpoint names it                                       |
| `CHAT_AI_SUBAGENT_MODEL`   | the turn's model     | The model sub-agents run on                                                            |
| `CHAT_AI_REASONING_EFFORT` | `medium`             | Sent as `reasoning_effort`: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `CHAT_AI_VIA_TAILNET`      | `false`              | Send model calls through the tailnet egress, as `PR_REVIEW_AI_VIA_TAILNET` does        |
| `CHAT_GATE_MODEL`          | `typesafe/jev-1.13`  | The reply gate's model on OpenRouter, called with labeling's `OPENROUTER_API_KEY`      |
| `PUBLIC_ORIGIN`            | none                 | The web app's origin, for the status message's transcript link                         |

Janitor enforces no spend cap. The 20-minute turn and the 10 sandboxes bound what a turn can spend, and the only cap on the total is the one you give the key: set a credit limit on `CHAT_AI_API_KEY` at the provider if you want one. Once it runs out, model calls fail, and every turn ends as failed with the provider's error category until the limit is raised.

### The bot's GitHub App and Multica member

The bot acts on GitHub as its own App, separate from janitor's, and in Multica as the Janitor member. The egress proxy hands each sandbox their credentials; without them it hands GitHub and Multica none, so the bot can still read public repositories but can't push or reach Multica.

| Setting                       | Meaning                                                        |
| ----------------------------- | -------------------------------------------------------------- |
| `CHAT_GITHUB_APP_ID`          | The bot App's id                                               |
| `CHAT_GITHUB_APP_PRIVATE_KEY` | The bot App's private key                                      |
| `CHAT_MULTICA_TOKEN`          | The Janitor member's non-expiring Multica PAT                  |
| `CHAT_MULTICA_WORKSPACE_ID`   | The Multica workspace the CLI acts in; defaults to Effectful's |

The production App is installed on every repository of Effect-TS and Effectful-Tech, private ones included, with contents, pull requests and issues read and write, and actions, checks, commit statuses and metadata read. The development App is installed only on `Effect-TS/janitor-sandbox`, so a local run never holds write tokens for real repositories. The Janitor member uses the mailbox `tech-ops@effectful.co`. Agents the bot should trigger must be visible to workspace members or list the Janitor user.

## Slack

### What it does

- A mention of the bot from an admitted user starts a session on the thread under the mention. When the bot joins a thread that already has messages, it reads the last 100 as context.
- In a thread with a session, every message from an admitted user reaches the session, and the reply gate decides whether it is meant for the bot. A message that mentions the bot always starts or steers a turn.
- Admitted users are full members of our workspace: `users.info` reports our `team_id`, and none of `is_restricted`, `is_ultra_restricted`, `is_stranger`, `deleted` or `is_bot`. Guests, Slack Connect users and strangers are outsiders. Their messages in a thread with a session reach the model as context only, and their mentions start nothing. A failed lookup also makes the author an outsider. An admission is remembered in the session for an hour, with the user's name.
- Messages from bots, janitor's own included, are context only. Edits, deletions and other message subtypes are ignored, except messages with files and thread replies also sent to the channel.
- In a Slack Connect channel the bot answers each mention to say it doesn't work there, and starts nothing. Every admitted message is checked, so a channel that becomes shared after a session started stops reaching that session. The bot's posts check too, at most once a minute per channel, so a running turn stops posting there.
- A direct message gets a one-line pointer to a channel, and starts nothing.
- Replies are posted as Markdown, up to 12,000 characters a message and a second apart. A reply that would need more than three messages is uploaded as `reply.md`. The bot's posts never unfurl links, and they carry `janitor_output` message metadata.

### Creating the Slack app

Create one app for production and one for development, each in our workspace.

1. Under **OAuth & Permissions**, add these bot token scopes: `app_mentions:read`, `channels:history`, `groups:history`, `channels:read`, `groups:read`, `users:read`, `chat:write`, `files:read`, `files:write` and `im:history`.
2. Under **Event Subscriptions**, turn events on and set the request URL to `https://<janitor host>/api/v1/webhooks/slack`. Slack sends a `url_verification` challenge, which the route answers only once the deployment has the Slack settings below. Subscribe to the bot events `app_mention`, `message.channels`, `message.groups` and `message.im`.
3. Leave **Interactivity** and **Socket Mode** off.
4. Under **App Home**, allow users to send messages from the **Messages** tab, so people can DM the bot and get the pointer.
5. Install the app to the workspace.

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

## Discord

Discord comes with "Discord ingress for the chat bot" (EFF-3020). Until then its kill switch exists but no thread uses it.

## Chat sessions page

**Chat sessions**, in the sidebar, lists every session janitor still keeps, latest activity first: the platform, the channel, a link to the thread, who started it, its turn count, the latest turn's status, its last activity and its total tokens. Anyone Cloudflare Access lets into janitor can read every session, private channels and private repositories included.

Each session links to its transcript, which the status message in the thread links to too. It shows the thread's messages and the turns in thread order. Each message shows its author and what the reply gate made of it: a mention, the gate's probability and whether it passed, "stop", context only (outsiders, bots and the backfill) or kept while switched off. Each turn shows its status, model and tokens, its time in the sandbox queue, its resumes, and whether it was told to wrap up, hit the deadline or was stopped, with its steps' tool calls and results collapsed. A running turn shows the steps it has finished. Everything shows as plain text, never as Markdown or HTML. There are no dollar amounts.

**Download JSON** saves the same data, which `GET /api/v1/chat/sessions/:sessionId/transcript` serves, with the session key URL-encoded as `:sessionId`. Once the session has expired or been deleted, the page says the transcript is gone and the endpoint answers `410`.

**Delete session** ends a session early: it cancels a running turn, releases the sandbox and deletes the history. A later message in the thread starts a new session, which reads the thread's last 100 messages again, so a pasted secret has to be deleted in Slack or Discord too.

While the bot is off for the whole deployment (`CHAT_AI_API_URL` or `CHAT_AI_API_KEY` unset), the sessions it kept are still listed, but their transcripts can't be read and they can't be deleted: the endpoints answer `503` until the bot is back on. A session that expires or is deleted removes its own row from the list. If that fails, it tries again every hour until the row is gone.

## Kill switch

The kill switch panel on the chat sessions page turns the bot off for every thread, or for Slack's or Discord's. Anyone with Access can use it. Turning it off for a thread's platform, or for every thread:

- stops its running turns within seconds, their status messages saying "Stopped";
- starts no new turn;
- tells each thread once that the bot is switched off, and keeps its messages as context for when it's back.

Off for every thread wins over the platform switches. Each change sets one switch and leaves the others as they are, so two people changing different switches never undo each other. The switch is stored in Postgres, and sessions read it every few seconds while a turn runs and on every message. A read that fails is retried, then answers the last state read; before any read has worked, it counts as off everywhere, so an unknown switch never lets a turn start. Turning it back on starts nothing by itself: the next message that wants a turn starts one.

## Accepted risks

1. A branch the bot pushes runs the repository's workflows, which have secrets and can call scripts the bot changed.
2. The bot can approve and merge pull requests, the changesets "Version Packages" one included. A prompt injection from repository content, an issue or a web page could lead to a merge and an npm publish.
3. Where a repository requires approvals, the bot's approval counts towards them.
4. On Discord, keeping private content out of public replies relies on the prompt alone.
5. There are no caps per person or on pull requests, issues, comments or pushes, and no loop detector. One person can fill the queue, and a confused turn can open many pull requests or issues before someone says "stop" or uses the kill switch. Each turn logs its action count.
6. Everyone with Access can read every transcript, private Slack channels and private repositories included.
7. An injected instruction the bot merges into `AGENTS.md`, `CLAUDE.md` or a skill folder is read by every later bot session and Multica agent on that repository.
8. After a resume, a comment the bot already posted may be posted again. Repeated pushes, pull requests and merges fail or do nothing.

## Logs

Logs carry `sessionId` and `turnId`, never message content, tool output or tokens. Each turn's end is logged with its status, action count, resumes and error category, and each kill switch change and web app delete with the session or the switch's new state.
