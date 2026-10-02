# Janitor

Janitor automates GitHub labeling, reviews explicitly invoked issues, and collaborates with teammates through Slack agent sessions.

Issue review requires deployment configuration and separate repository opt-in. See the [issue review operator guide](docs/issue-review.md) for setup, dry-run publication, cancellation, retention, and rollout checks.

## Development

Effect dependencies use commit-pinned CI snapshots configured in `pnpm-workspace.yaml`. One root install covers every application.

```sh
vp install --frozen-lockfile
alchemy profile edit --add Infisical   # once per machine
vp run dev
```

`alchemy dev` loads shared development settings, such as the model and Slack credentials, from Infisical (project `janitor`, environment `development`). Ask for a machine identity with read access, then paste its universal-auth client ID and secret into the profile prompt. `deployment/local.env` pins the local Cloudflare emulator identity over Infisical, and variables exported in your shell override both. Every integration in the development environment is optional; a missing one stays disabled.

Alchemy starts Postgres, the API on port 8787, and the website on 1337. Development needs Docker or Podman. Slack sessions run in the API Worker and lazily start a Node sandbox container for repository operations. The Slack integration is currently disabled; see [Slack setup](docs/slack/README.md) to turn it back on.

```sh
# Formatting, lint, type checking, and tests:
vp run check:all
```

Each Slack thread has a Durable Object that stores conversation history and queued inputs and runs Effect Chat through OpenRouter. Its container holds an ephemeral repository checkout. See [Slack sessions in the API Worker](docs/adr/0005-slack-sessions-in-the-api-worker.md) and [sandbox services](packages/alchemy/README.md).

There is no Cloudflare edge locally, so Access attributes requests to the `local-dev` identity. Local audit entries record that identity; production does not accept it. Live GitHub operations are disabled in the default local composition.

## Teammates and connected accounts

Cloudflare Access decides who may use Janitor. Anyone who can sign in is a
teammate with every permission; there are no roles. To take someone's access
away, remove them from the Access policy. Their connected Slack and GitHub
accounts keep working until they disconnect them, so ask them to disconnect
before they go.

Locally there is no Access, so requests act as the simulated `local-dev`
identity.

Connected accounts are proven by the platforms, never by email or display
name, and stay authorized until disconnected in Janitor or the teammate is
removed, independently of the browser session:

- **Slack** uses Sign in with Slack (OpenID Connect). Create a Slack app,
  enable Sign in with Slack with the `openid` and `profile` user scopes, add
  `https://<domain>/account/slack/return` as a redirect URL, and set
  `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` and `SLACK_WORKSPACE_ID` (the
  workspace's `T…` team ID, shared with the bot). Janitor checks
  the ID token's signature, issuer, audience, expiry, nonce and workspace; a
  token from another workspace is refused. These user scopes are separate from
  the bot scopes the Slack integration itself needs.
- **GitHub** uses the GitHub App's user authorization. On the production
  GitHub App, add `https://<domain>/account/github/return` as a callback URL,
  generate a client secret, and set `GITHUB_OAUTH_CLIENT_ID` and
  `GITHUB_OAUTH_CLIENT_SECRET`. Janitor exchanges the code once, looks
  up the numeric user ID, and never stores the user token.

Locally the callbacks return to `http://localhost:1337/account/<platform>/return`;
register those URLs on development apps if you want to exercise linking. Each
platform is optional: an unconfigured platform shows as unavailable on the
Account page and nothing else changes. Each account belongs to one teammate at
a time; connecting a different account for the same workspace replaces the
earlier link with new proof.

Each repository has a separate GitHub sync switch in its Settings section.
Turning it off retains cached data and auto-labeling configuration, cancels
queued sync claims, and excludes that repository from scheduled repair, manual
sync, and sync status totals. Re-enabling requests fresh scans. Work already
fetching from GitHub may finish, but its old claim cannot publish results after
sync is disabled. Webhook journaling and projection continue to accept events.

Seeded repositories start with sync off while keeping their labeling settings.
Their synthetic installation also has sync disabled, so installation inventory
does not request a token for fixture installation `77`. Real installations and
new repositories default to sync on; repository enablement still controls
whether Janitor bootstraps their content.

To point the local web app at a deployed stage instead, log in through
`cloudflared` and pass the token along with the origin. Both go in `.env`,
which direnv loads and git ignores:

```bash
cloudflared access login https://janitor.effectful.co
cloudflared access token --app https://janitor.effectful.co
```

```
JANITOR_API_ORIGIN=https://janitor.effectful.co
CF_ACCESS_TOKEN=<the token>
```

The token expires with the Access session. Anything you save in that mode
changes the deployed configuration.

Private Slack agent conversations use a separate bot installation configuration.
See [Slack setup and delivery behavior](docs/slack/README.md).
