# Operating the chat bot

The chat bot is a team agent people talk to from Slack and Discord. Each thread is a chat session: mention the bot to start one, and it runs clanka in a chat sandbox with access to every repository in Effect-TS and Effectful-Tech. ADR 0014 records the design, and `CONTEXT.md` defines the terms.

The bot is off for the whole deployment until `CHAT_AI_API_URL` and `CHAT_AI_API_KEY` are set. Each platform is also off until its own settings are set. While the bot or a platform is off, its settings aren't read and nothing is bound, so a deploy can go out before any secret exists.

## What it does

- A mention of the bot starts a session on its thread, and the session's first turn. When the bot joins a thread that already has messages, it reads the last 100 as context.
- In a thread with a session, the reply gate decides whether a message without a mention needs the bot to answer or act. It asks Jev, with the last 20 messages as context and two signals read off the thread (whether the message comes straight after the bot's reply to its author, and how many people, bots aside, have spoken), and a message passes at a probability of one half or more. Acknowledgements and refusals of what the bot proposed are meant to stay below it. A mention always skips the gate, and on Discord a reply to one of the bot's messages counts as a mention.
- A 👍 reaction, any skin tone, from an admitted user on one of the bot's messages in a thread with a session counts as approval: the session gets it as a message from that user saying they approved, which counts as a mention. So a yes/no question or a request for approval can be answered with a thumbs up. Other reactions, reactions from anyone else and reactions in a thread without a session are ignored, and a reaction never starts a session.
- A message that passes while a turn is running steers it: the model sees it between its steps. A message that is only "stop" stops the running turn before any model sees it.
- Each turn runs clanka in a chat sandbox, a container of its own class so chat can't starve PR review. Nothing is checked out up front: the model clones what it needs into `/workspace/<org>/<repo>`. It can push to any branch except protected ones, open and merge pull requests, and use the `multica` CLI as the Janitor member, for example to hand larger work to a squad as an issue. The egress proxy adds the credentials; the sandbox holds none.
- The thread gets a status message that the bot edits as the turn goes, with a link to the session's transcript, and then the reply. A plain reply ends the turn.
- After a turn, the sandbox stays warm for 30 minutes, so a follow-up finds its clones and edits. Durable work is pushed work: anything not pushed is gone once the sandbox is.
- A turn that loses its sandbox, or is cut off by a restart, resumes on a fresh one, up to three times. The model is told the sandbox is new and to check what it already pushed, opened or commented before redoing a step.
- At 35 minutes the turn is told to wrap up, and at 40 it stops. Time spent waiting for a sandbox doesn't count. When all 10 sandboxes are running turns, a turn waits in one queue shared by every platform, and gives up after 15 minutes with a message that the bot is busy.
- When the model provider fails once clanka's retries run out (quota, auth, 5xx), the turn ends, and the status message gives the error's category.
- A session expires 30 days after its last message, and its storage and transcript go with it. A later message starts a new session with a fresh backfill.

### Limits

| Setting                        | Default | Meaning                                                                |
| ------------------------------ | ------- | ---------------------------------------------------------------------- |
| `CHAT_TURN_DEADLINE_SECONDS`   | 2400    | A turn's hard deadline, from its start and across resumes              |
| `CHAT_WRAP_UP_AFTER_SECONDS`   | 2100    | When a turn is told to wrap up, from its start                         |
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

Chat turns and their sub-agents request OpenAI priority processing with `service_tier: "priority"`. The endpoint and model must support this tier; provider priority pricing applies. PR review and the reply gate are unchanged.

| Setting                    | Default              | Meaning                                                                                |
| -------------------------- | -------------------- | -------------------------------------------------------------------------------------- |
| `CHAT_AI_MODEL`            | `openai/gpt-6-astra` | The model turns run on, as the endpoint names it                                       |
| `CHAT_AI_SUBAGENT_MODEL`   | the turn's model     | The model sub-agents run on                                                            |
| `CHAT_AI_REASONING_EFFORT` | `medium`             | Sent as `reasoning_effort`: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `CHAT_AI_VIA_TAILNET`      | `false`              | Send model calls through the tailnet egress, as `PR_REVIEW_AI_VIA_TAILNET` does        |
| `CHAT_GATE_MODEL`          | `typesafe/jev-1.13`  | The reply gate's model on OpenRouter, called with labeling's `OPENROUTER_API_KEY`      |
| `PUBLIC_ORIGIN`            | none                 | The web app's origin, for the status message's transcript link                         |

The reply gate has an eval set, `apps/cluster/scripts/chat-gate-eval-cases.ts`: real Slack and Discord threads (pseudonymised) and handwritten ones, each with the verdict the gate should reach on its newest message. `node apps/cluster/scripts/chat-gate-eval.ts` replays it through the real gate with `OPENROUTER_API_KEY` and reports the misses, a threshold sweep and drift from production. Rerun it when the prompt, model or threshold changes, and add a case whenever the gate gets a message wrong (EFF-3137).

Janitor enforces no spend cap. The 40-minute turn and the 10 sandboxes bound what a turn can spend, and the only cap on the total is the one you give the key: set a credit limit on `CHAT_AI_API_KEY` at the provider if you want one. Once it runs out, model calls fail, and every turn ends as failed with the provider's error category until the limit is raised.

### The bot's GitHub App and Multica member

The bot acts on GitHub as its own App, separate from janitor's, and in Multica as the Janitor member. The egress proxy hands each sandbox their credentials; without them it hands GitHub and Multica none, so the bot can still read public repositories but can't push or reach Multica.

| Setting                       | Meaning                                                         |
| ----------------------------- | --------------------------------------------------------------- |
| `CHAT_GITHUB_APP_ID`          | The bot App's id                                                |
| `CHAT_GITHUB_APP_PRIVATE_KEY` | The bot App's private key                                       |
| `CHAT_MULTICA_TOKEN`          | The Janitor member's non-expiring Multica PAT                   |
| `CHAT_MULTICA_WORKSPACE_ID`   | The Multica workspace the CLI acts in; defaults to Effectful's  |
| `CHAT_MULTICA_WORKSPACE_SLUG` | That workspace's slug, for issue links; defaults to Effectful's |

The production App is installed on every repository of Effect-TS and Effectful-Tech, private ones included, with contents, pull requests and issues read and write, and actions, checks, commit statuses and metadata read. The development App is installed only on `Effect-TS/janitor-sandbox`, so a local run never holds write tokens for real repositories. The Janitor member uses the mailbox `tech-ops@effectful.co`. Agents the bot should trigger must be visible to workspace members or list the Janitor user.

### Browser Run

The bot can render pages with Cloudflare Browser Run's Quick Actions: screenshots, markdown of a JavaScript-rendered page, accessibility trees, PDFs, links, scrapes (EFF-3303). The sandbox calls `POST http://browser-run.internal/<action>` with the action's options as JSON. That host never leaves the Worker, so plain `http` is enough: the egress proxy runs the action on the Worker's `BROWSER` binding and returns the binding's response unchanged, so no Cloudflare token exists. Before each action the proxy asks the session's workspace whether the turn still holds the sandbox. Between turns every request is refused, so a sandbox kept warm after its turn can't spend browser time. Only the Quick Actions the binding runs get through, matched exactly: `content`, `screenshot`, `pdf`, `markdown`, `snapshot`, `accessibilityTree`, `scrape`, `json` and `links`. Any other path is refused, encoded ones included. That covers `crawl`, which the binding doesn't offer, and browser sessions, which need WebSockets the container's egress doesn't carry. The `browser-run` skill in the skills repository shows the calls.

The binding is declared while the chat bot is on. Set `CHAT_BROWSER_RUN` to `false` in Infisical (project `janitor`) to leave it off; the proxy then refuses every Browser Run request. Under `alchemy dev` the binding drives a local Chrome, which doesn't run Quick Actions, so they fail locally.

Quick Actions bill browser time only, a few seconds each, against the 10 hours a month Workers Paid includes; past that it is $0.09 an hour. Janitor enforces no spend cap. Usage is on the dashboard's Browser Run page.

### The bot's skills

Every sandbox gets the `multica-platform` skill bundled with janitor. To give the bot more, point it at a GitHub repository that holds one folder per skill under `.agents/skills`, each with a `SKILL.md` and any supporting files, for example `.agents/skills/triage/SKILL.md`. That is where `npx skills add` installs vendored skills, and custom skills go next to them. Every folder with a valid `SKILL.md` is a skill. A `skills-lock.json` at the repository's root is optional: it helps keep vendored skills up to date, and janitor never reads it. Changes merged there reach every sandbox started after the merge, with no janitor deploy. A warm sandbox keeps the skills it started with, so a session picks up a change once its sandbox is replaced. Effect's deployment sets `CHAT_SKILLS_REPOSITORY` to `Effect-TS/janitor-skills` in Infisical (project `janitor`).

| Setting                  | Default            | Meaning                                            |
| ------------------------ | ------------------ | -------------------------------------------------- |
| `CHAT_SKILLS_REPOSITORY` | none               | The skills repository, as `owner/name`             |
| `CHAT_SKILLS_DIRECTORY`  | `.agents/skills`   | The directory in it that holds the skill folders   |
| `CHAT_SKILLS_REF`        | the default branch | The branch, tag or commit the skills are read from |

With `CHAT_SKILLS_REPOSITORY` unset, the bot gets only `multica-platform`. A bad value fails the deploy, as other chat settings do.

Janitor reads the repository through its own GitHub App, not the bot's, so install janitor's App on it. Each time a sandbox starts, janitor resolves the ref to a commit and logs the repository and the commit's SHA, so a reply can be traced back to the skills it ran with. The skills are read from GitHub once per commit and kept in memory after that.

- `multica-platform` describes the CLI baked into the image, so it always wins: a folder of that name in the repository is skipped.
- A folder without a `SKILL.md`, or with a name or file path the sandbox won't accept, is skipped. Names are lowercase letters, digits and dashes. Files directly in the skills directory are ignored.
- The skills may hold at most 200 files and 1 MiB.
- When the repository can't be read, for example because the App isn't installed, the repository is missing, GitHub is rate limiting, or the skills are over the cap, the sandbox gets `multica-platform` only and janitor logs a warning. Chat keeps working.

Whoever can merge to the skills repository is giving instructions to a bot that acts as its GitHub App and Multica member, so protect its branch the way you protect janitor's.

### Keeping the multica CLI and skill in sync

The `Bump multica CLI` workflow runs daily at 05:23 UTC and can be dispatched manually
from `main`. It updates the CLI version and linux-amd64 checksum in `MulticaCli.ts`,
then regenerates `MulticaSkill.ts` from the same tag. An unchanged version does nothing;
a missing checksum fails before either pin is written. The fixed `bump/multica-cli`
branch has at most one open PR against `main`.

Set repository Actions secrets `MULTICA_BUMP_APP_ID` (the GitHub App's numeric ID) and
`MULTICA_BUMP_APP_PRIVATE_KEY` (its PEM private key). The App must be installed on
`Effect-TS/janitor` with Contents and Pull requests read/write. These are repository
secrets, not Infisical settings. The App token lets the bump PR trigger Check.
Enable **Allow auto-merge** and require the `check` status on `main`; do not give the
App a ruleset bypass. Auto-merge then waits for Check, and Deploy ships the merged pin.

To bump locally, run `vp run chat:multica-cli-bump` followed by
`vp run chat:multica-skill`, and commit both files together. Do not run `multica update`
in the sandbox or install an unpinned binary while the image builds.

## Slack

### What it does

- A mention of the bot from an admitted user starts a session on the thread under the mention. When the bot joins a thread that already has messages, it reads the last 100 as context.
- In a thread with a session, every message from an admitted user reaches the session, and the reply gate decides whether it is meant for the bot. A message that mentions the bot always starts or steers a turn.
- Admitted users are full members of our workspace: `users.info` reports our `team_id`, and none of `is_restricted`, `is_ultra_restricted`, `is_stranger`, `deleted` or `is_bot`. Guests, Slack Connect users and strangers are outsiders. Their messages in a thread with a session reach the model as context only, and their mentions start nothing. A failed lookup also makes the author an outsider. An admission is remembered in the session for an hour, with the user's name.
- Messages from bots, janitor's own included, are context only. Edits, deletions and other message subtypes, `/me` actions included, are ignored, except messages with files and thread replies also sent to the channel.
- A 👍 (`+1` or `thumbsup`, any skin tone) from an admitted user on one of the bot's messages is an approval. A `reaction_added` event names the message but not its thread, so ingress reads the thread with `conversations.replies`, and ignores the reaction when the message is in no thread or Slack won't show it.
- A direct message gets a one-line pointer to a channel, and starts nothing.
- Replies are posted as Markdown with `effect/chat`'s `ChatMarkdown`, split at block boundaries into messages of up to 12,000 characters, a second apart. After three messages, the rest of a reply is uploaded as `reply.md` with the last one. When Slack refuses a reply's files, whatever of it hasn't gone out is posted as text, ending in a note naming the files. The bot's posts never unfurl links. They no longer carry `janitor_output` message metadata: `@effect/chat-slack` has no option for it.

### Creating the Slack app

Create one app for production and one for development, each in our workspace.

1. Under **OAuth & Permissions**, add these bot token scopes: `app_mentions:read`, `channels:history`, `groups:history`, `channels:read`, `groups:read`, `users:read`, `chat:write`, `files:read`, `files:write`, `im:history` and `reactions:read`.
2. Under **Event Subscriptions**, turn events on and set the request URL to `https://<janitor host>/api/v1/webhooks/slack`. Slack sends a `url_verification` challenge, which the route answers only once the deployment has the Slack settings below. Subscribe to the bot events `app_mention`, `message.channels`, `message.groups`, `message.im` and `reaction_added`.
3. Leave **Interactivity** and **Socket Mode** off.
4. Under **App Home**, allow users to send messages from the **Messages** tab, so people can DM the bot and get the pointer.
5. Install the app to the workspace. After adding a scope to an installed app, such as `reactions:read` for approvals, reinstall it.

### Settings

Slack is on once all four of these are set, and off while any of them is missing. They live in Infisical, in the `janitor` project.

| Setting                | Where to find it                                               |
| ---------------------- | -------------------------------------------------------------- |
| `SLACK_SIGNING_SECRET` | **Basic Information**, **Signing Secret**                      |
| `SLACK_BOT_TOKEN`      | **OAuth & Permissions**, **Bot User OAuth Token** (`xoxb-...`) |
| `SLACK_WORKSPACE_ID`   | The workspace's team id (`T...`)                               |
| `SLACK_APP_ID`         | **Basic Information**, **App ID** (`A...`)                     |

The webhook path skips Cloudflare Access, like GitHub's, and relies on the signature: an HMAC-SHA-256 of `v0:{timestamp}:{body}` with the signing secret, within 300 seconds of the request's timestamp. `@effect/chat-slack`'s webhook checks both and parses the events. Each event's `api_app_id` must match the settings, and its `team_id` too unless `authorizations` lists our workspace, as it does for a Slack Connect channel another organization hosts. An event for another app or workspace is acknowledged with 200 and dropped, so Slack doesn't deliver it again. The route answers within 2.5 seconds of the request, reading the body included, or answers 503 so Slack delivers the event again, and sessions ignore a message they already have. Each 503 is logged as "Slack webhook answered 503", without the request's content. The status alone doesn't give the cause: a handler that refused the event logs "Slack webhook failed" with its error first, and no other line means the bot user couldn't be read or the deadline passed.

### Inviting the bot

The bot only hears channels it is a member of. In a channel, type `/invite @janitor` (or the app's display name). Roll out to one private core-team channel first, and to public channels once the smoke test passes.

### Development

The development stack's `janitor-dev` tunnel forwards `/api/v1/webhooks/slack` to the local Worker, next to the GitHub webhook. Point the development app's request URL at the tunnel's hostname, and keep it in a test channel.

## Discord

### What it does

- A mention of the bot from an admitted user in a text or announcement channel starts a thread from that message, archived after a day of quiet, and a session on it. A mention inside an existing thread uses that thread. When the bot joins a thread that already has messages, it reads the last 100 as context.
- In a thread with a session, every message from the configured server reaches the session, and the reply gate decides whether it is meant for the bot. A message that mentions the bot, or replies to one of the bot's messages, always starts or steers a turn.
- Admitted users are those with the configured role in `member.roles` on the message. A revoked role counts from the author's next message. Everyone else in the server is an outsider: their messages in a thread with a session reach the model as context only, and their mentions start nothing. Messages from other servers, and messages with no member, such as webhooks, are ignored.
- Messages from other bots are context only. janitor's own replies are already in the session, so the gateway skips them, and the backfill reads them as bot messages. Edits, deletions, and system messages such as joins and pins are ignored.
- A 👍, any skin tone, from an admitted user on one of the bot's messages in a thread with a session is an approval. Admission reads the reaction's `member.roles`, as for a message.
- A direct message gets a one-line pointer to a channel, and starts nothing.
- Replies are posted as Markdown with `effect/chat`'s `ChatMarkdown`, split at block boundaries into messages of up to 2,000 characters, with code fences kept balanced. The first one answers the message that started the turn. It mentions the author instead when an approval or the thread's starter message started the turn, and goes out as a plain message when that message was deleted since. After five messages, the rest of a reply is uploaded as `reply.md` with the last one. When Discord refuses a reply's files, whatever of it hasn't gone out is posted as text, ending in a note naming the files. Replies can ping users, never a role, `@everyone` or `@here`. Status messages ping nobody, and no post unfurls links.
- Attachments from admitted users are fetched from Discord's CDN for the turn, up to 20 MB each.

### The gateway

Discord has no webhook for messages, so one Durable Object, `ChatDiscordGateway`, holds the bot's gateway socket with dfx's shard. It hands `MESSAGE_CREATE` and `MESSAGE_REACTION_ADD` to `@effect/chat-discord`'s `dispatch`, which parses them into `effect/chat` events; it doesn't use the adapter's own gateway layer, which can't resume from the object's storage. The Worker's one-minute cron starts it, and its own 60-second alarm restarts the shard if it dies or goes quiet for three minutes. The shard's session is kept in the object's storage, so after an eviction or a deploy the object resumes the session, and Discord replays what arrived while the socket was down. The object remembers the message and approval ids it handled for a day and drops the replays.

A message is handled before the shard stores its sequence number. If its session can't be reached, the shard reconnects and the RESUME delivers the message again. A request Discord refuses, such as a thread the bot lacks permission to create, is logged and the message dropped.

Apart from starting threads and the direct message pointer, the object never posts to Discord: replies and status messages come from the session.

If Discord closes the socket with 4014, the app isn't allowed an intent it asks for, usually Message Content. With 4004, the token is wrong. The object logs `Discord closed the gateway with 4014` (or `4004`) and the reason, and waits an hour before it tries again, so a misconfigured app stays well inside Discord's 1,000 IDENTIFYs a day. Fix the setting, then deploy, or wait for the hour to pass.

### Creating the Discord app

Create one app for production and one for development, in the [Discord developer portal](https://discord.com/developers/applications). The development app goes in a private test server.

1. Under **Bot**, turn on the **Message Content** intent. Leave the other privileged intents off. The bot also asks for `GUILDS`, `GUILD_MESSAGES`, `GUILD_MESSAGE_REACTIONS` and `DIRECT_MESSAGES`, which need no toggle.
2. Under **Bot**, reset the token and copy it.
3. Under **OAuth2**, **URL Generator**, pick the `bot` scope and the permissions **View Channels**, **Send Messages**, **Send Messages in Threads**, **Create Public Threads**, **Read Message History** and **Attach Files**. Open the URL and add the bot to the server.
4. Create the role whose holders may use the bot, or pick an existing one.

### Settings

Discord is on once all three of these are set, and off while any of them is missing. They live in Infisical, in the `janitor` project.

| Setting             | Where to find it                                                                 |
| ------------------- | -------------------------------------------------------------------------------- |
| `DISCORD_BOT_TOKEN` | **Bot**, **Token**                                                               |
| `DISCORD_GUILD_ID`  | With developer mode on in Discord, right-click the server and **Copy Server ID** |
| `DISCORD_ROLE_ID`   | **Server Settings**, **Roles**, right-click the role and **Copy Role ID**        |

Turning the bot or Discord off takes a deploy, which restarts the gateway. The restarted object finds no settings, starts no shard, and on its next alarm forgets its session and stops waking. It stays declared, so its storage survives, and turning Discord on again starts a new gateway session.

### Inviting the bot

The bot hears every channel it can view. Restrict it with channel permissions: roll out to one staff-only channel first, and to wider channels for role holders after a week without incidents.

### Development

The gateway is an outbound socket, so the development app needs no tunnel. A local `alchemy dev` run with the three settings from Infisical's development environment connects within a minute, on the cron's first tick. Only one process should hold the development app's gateway at a time: two would each get every message.

## MCP servers

### What it does

Turns can use MCP servers configured on the dashboard, in the **MCP servers** panel of the chat sessions page (EFF-3443). Every tool of each enabled server is offered, as `mcp.<name>.<tool>`, to the turn and its sub-agents. Anyone Cloudflare Access lets into janitor can add, change, connect and delete servers, the same people who can use the kill switch.

- A **private** server, the default, is offered only in Slack channels of our workspace that hold no one from outside it. Before a session's first turn that has a private server to offer, the session asks Slack's `conversations.info` about the thread's channel. It allows the channel only when `is_shared`, `is_ext_shared`, `is_org_shared` and `is_pending_ext_shared` are all present and false, and the name doesn't start with `effectful-x-`. Public and private channels both qualify.
- Discord never gets private servers. Neither does a channel whose lookup fails, a rate limit included: the turn goes on with only the other servers, and the next turn asks again. A yes is kept for the session.
- A server that isn't private is offered in every thread, Discord and Slack Connect channels included.
- The list is read from Postgres at the start of each turn. If that read fails, the turn gets no servers, so a private server is never offered unchecked. Changes on the dashboard apply from the next turn; a running turn keeps the servers it started with.
- The connections run in the Worker and are opened for each turn. Each request fetches its token from the server's credential and adds it there, so the sandbox, the model's prompts, tool results and logs never see it. A server whose credential has no token for the turn doesn't connect, and the turn goes on without it.
- A 401 from a server marks its token as rejected, so the next request gets a new one. The request that got the 401 is never sent again, so a write can't reach the server twice; the model sees that tool call fail.

### Authentication and credentials

Each server has one of three kinds of authentication, fixed when it's added:

- `none`: requests carry no credential.
- `bearer`: a token entered on the dashboard, sent as `Authorization: Bearer`. It can be replaced but never read back.
- `oauth`: **Connect** on the dashboard discovers the server's authorisation server from its OAuth metadata, registers a client for janitor, and sends the browser to consent with PKCE (S256). The authorisation server sends the browser back to `/api/v1/chat/mcp-servers/<id>/oauth/callback`, which exchanges the code within 10 minutes of the start, once. Connect needs `PUBLIC_ORIGIN`, which every deployment sets.

Bearer tokens and OAuth state live only in the server's own Durable Object (`McpCredential`, one per server, named by its id), never in Postgres, Infisical, API responses or logs. The object refreshes OAuth access tokens one at a time, across every session, and stores a rotated refresh token before it hands out the new access token. After a failed refresh it waits 30 seconds before trying again. If the authorisation server answers `invalid_grant` or `invalid_client`, the server shows **Needs consent** until someone runs Connect again.

An access token is reused while more than five minutes of it are left. With hour-long tokens that's one refresh every 55 minutes. A token that lives five minutes or less, or an answer without `expires_in`, which is taken to mean five minutes, is refreshed for every MCP request: one token request, and one refresh token rotation, per request. If a provider issues tokens that short, the window should scale with the token's lifetime instead.

If the authorisation server rotates the refresh token and its answer is lost (a timeout, or the object restarting before the write), the next refresh gets `invalid_grant` and the server needs Connect again.

### Attio

Attio's hosted server is the first one to add:

1. Add a server named `attio`, URL `https://mcp.attio.com/mcp`, authentication `oauth`, with Private on.
2. Click **Connect** while signed in to Attio as the member the bot should act as, such as `tech-ops@effectful.co`. Every Attio call then has that member's permissions, and Attio's audit log shows that member.
3. In a development deployment, ask the bot for Attio's `whoami` in a test channel. That read is the smoke test: no CRM writes.
4. In production, try it in one private core-team channel before relying on it elsewhere.

The existing Attio Slack bot is separate and unchanged.

### Revocation

- To stop a server, switch it off on the dashboard, or delete it, which also wipes its credential. The kill switch stops every turn without either.
- To revoke an OAuth grant at the provider, end the member's session there. For Attio, that's the member's account settings, or `https://app.attio.com/oidc/revoke`. To revoke a bearer token, revoke it at the provider and clear or delete the server.

### Limits

- Every tool is offered, writes and deletes included, with no confirmation of janitor's own. Confirmations a server asks for through its MCP client go unanswered.
- A turn with MCP servers keeps GitHub, Multica and internet access. Nothing stops their data from leaving through them.
- Tool results are in the session's transcript, which everyone with Access can read.
- The channel is checked once per session, so a sharing change goes unnoticed for that session.
- The sharing flags say nothing about guests: a guest in an internal channel can read the bot's replies there.
- A server that isn't private is reachable from public Discord channels.
- Anyone with Access can add a server that every thread can use.

## Chat sessions page

**Chat sessions**, in the sidebar, lists every session janitor still keeps, latest activity first: the platform, the channel, a link to the thread, who started it, its turn count, the latest turn's status, its last activity and its total tokens. Anyone Cloudflare Access lets into janitor can read every session, private channels and private repositories included.

Each session links to its transcript, which the status message in the thread links to too. It shows the thread's messages and the turns in thread order. Each message shows its author and what the reply gate made of it: a mention, the gate's probability and whether it passed, "stop", context only (outsiders, bots and the backfill) or kept while switched off. Each turn shows its status, model and tokens, its time in the sandbox queue, its resumes, and whether it was told to wrap up, hit the deadline or was stopped, with its steps' tool calls and results collapsed. A running turn shows the steps it has finished. Everything shows as plain text, never as Markdown or HTML. There are no dollar amounts.

**Download JSON** saves the same data, which `GET /api/v1/chat/sessions/:sessionId/transcript` serves, with the session key URL-encoded as `:sessionId`. Once the session has expired or been deleted, the page says the transcript is gone and the endpoint answers `410`.

**Delete session** ends a session early: it cancels a running turn, releases the sandbox and deletes the history. A later message in the thread starts a new session, which reads the thread's last 100 messages again, so a pasted secret has to be deleted in Slack or Discord too.

While the bot is off for the whole deployment (`CHAT_AI_API_URL` or `CHAT_AI_API_KEY` unset), the sessions it kept are still listed, but their transcripts can't be read and they can't be deleted: the endpoints answer `503` until the bot is back on. A session that expires or is deleted removes its row from the list before it deletes its storage, and keeps both if the removal fails: the delete then fails and can be retried, and the expiry tries again an hour later.

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
4. On Discord, keeping private content out of public replies relies on the prompt alone. So does keeping it out of replies in Slack Connect channels, which another organization reads.
5. There are no caps per person or on pull requests, issues, comments or pushes, and no loop detector. One person can fill the queue, and a confused turn can open many pull requests or issues before someone says "stop" or uses the kill switch. Each turn logs its action count.
6. Everyone with Access can read every transcript, private Slack channels and private repositories included.
7. An injected instruction the bot merges into `AGENTS.md`, `CLAUDE.md` or a skill folder is read by every later bot session and Multica agent on that repository.
8. After a resume, a comment the bot already posted may be posted again. Repeated pushes, pull requests and merges fail or do nothing.

## Logs

Logs carry `sessionId` and `turnId`, never message content, tool output or tokens. Each turn's end is logged with its status, action count, resumes and error category, and each kill switch change and web app delete with the session or the switch's new state.
