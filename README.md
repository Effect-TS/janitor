# Janitor

Janitor is a GitHub and Slack collaboration application with an OpenCode agent runner.

## Development

Effect dependencies use commit-pinned CI snapshots. One root install covers every application, including the runner. See [Effect snapshot dependencies](docs/effect-snapshots.md) for pins and upgrade checks.

```sh
vp install --frozen-lockfile
vp run dev
```

Alchemy starts Postgres, the API on port 8787, the website on 1337, and the runner on 8790 with one Linux sandbox container per agent session. Open the website. The runner uses a fixture repository inside the sandbox image and a controlled model by default, so development needs Docker or Podman but no production credentials. Runner configuration and live-model opt-in are described in the [runner guide](apps/runner/README.md).

```sh
# Optional, while the local stack is running: a turn, a container replacement and a restore.
vp run runner:smoke

# Project checks, including the runner:
vp run check:all
```

PR checks run formatting, lint, type checking, the runner bundle and the focused test suites; the local Alchemy smoke is opt-in and is not a CI gate.

The API, website and runner belong to the root Alchemy deployment. The runner retains its own Worker for its Workerd-specific bundle. Each agent session's Durable Object owns its sandbox container, hosts OpenCode and keeps conversation state; the container holds the repository checkout, commands and background processes. See [why the Worker remains separate](docs/adr/0001-runner-worker-and-linux-workspace.md), [completed-turn recovery](docs/adr/0003-completed-turn-recovery-and-repository-authority.md) and [the sandbox-owning object](docs/adr/0004-host-opencode-in-the-sandbox-owning-object.md).

There is no Cloudflare edge locally, so Access attributes requests to the `local-dev` identity. Local audit entries record that identity; production does not accept it. Live GitHub operations are disabled in the default local composition.

## Teammates and connected accounts

Signing in through Access is not enough on its own: every API request also
needs an active Janitor membership. The first person to sign in with the
Access subject named by `JANITOR_INITIAL_ADMIN_SUBJECT` becomes the admin;
everyone else is admitted as a member on first sign-in. Admins manage roles,
removal and restoration from the Account page. Removal disables a teammate's
connected accounts and sign-in while keeping their accepted work and
attribution; signing in or relinking does not undo it. The last active admin
cannot be removed or demoted.

To find your Access subject, decode the token from `cloudflared access token`
and read its `sub` claim:

```bash
cloudflared access token --app https://janitor.effectful.co | cut -d. -f2 | base64 -d 2>/dev/null | sed 's/.*"sub":"\([^"]*\)".*/\1\n/'
```

Locally there is no Access, so the simulated `local-dev` identity is the
initial admin and no configuration is needed.

Connected accounts are proven by the platforms, never by email or display
name, and stay authorized until disconnected in Janitor or the teammate is
removed, independently of the browser session:

- **Slack** uses Sign in with Slack (OpenID Connect). Create a Slack app,
  enable Sign in with Slack with the `openid` and `profile` user scopes, add
  `https://<domain>/account/slack/return` as a redirect URL, and set
  `JANITOR_SLACK_CLIENT_ID`, `JANITOR_SLACK_CLIENT_SECRET` and
  `JANITOR_SLACK_WORKSPACE_IDS` (the workspace's `T…` team ID). Janitor checks
  the ID token's signature, issuer, audience, expiry, nonce and workspace; a
  token from another workspace is refused. These user scopes are separate from
  the bot scopes the Slack integration itself needs.
- **GitHub** uses the GitHub App's user authorization. On the production
  GitHub App, add `https://<domain>/account/github/return` as a callback URL,
  generate a client secret, and set `JANITOR_GITHUB_OAUTH_CLIENT_ID` and
  `JANITOR_GITHUB_OAUTH_CLIENT_SECRET`. Janitor exchanges the code once, looks
  up the numeric user ID, and never stores the user token.

Locally the callbacks return to `http://localhost:1337/account/<platform>/return`;
register those URLs on development apps if you want to exercise linking. Each
platform is optional: an unconfigured platform shows as unavailable on the
Account page and nothing else changes. Each account belongs to one teammate at
a time; connecting a different account for the same workspace replaces the
earlier link with new proof. A removed teammate keeps ownership of their
accounts so nobody else can claim them.

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
