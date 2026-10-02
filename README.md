# Janitor

Janitor automates GitHub labeling.

## Development

Effect dependencies use commit-pinned CI snapshots configured in `pnpm-workspace.yaml`. One root install covers every application.

```sh
vp install --frozen-lockfile
alchemy profile edit --add Infisical   # once per machine
vp run dev
```

`alchemy dev` loads shared development settings, such as the OpenAI key for AI labeling rules, from Infisical (project `janitor`, environment `development`). Ask for a machine identity with read access, then paste its universal-auth client ID and secret into the profile prompt. `deployment/local.env` pins the local Cloudflare emulator identity over Infisical, and variables exported in your shell override both. Every integration in the development environment is optional; a missing one stays disabled.

Alchemy starts Postgres, the API on port 8787, and the website on 1337. Development needs Docker or Podman.

```sh
# Formatting, lint, type checking, and tests:
vp run check:all
```

There is no Cloudflare edge locally, so Access attributes requests to the `local-dev` identity. Local audit entries record that identity; production does not accept it. Live GitHub operations are disabled in the default local composition.

## Teammates and connected accounts

Cloudflare Access decides who may use Janitor. Anyone who can sign in is a
teammate with every permission; there are no roles. To take someone's access
away, remove them from the Access policy.

Locally there is no Access, so requests act as the simulated `local-dev`
identity.

A teammate can connect their GitHub account, proven by GitHub rather than by
email or display name. Linking uses the GitHub App's user authorization. On
the production GitHub App, add `https://<domain>/account/github/return` as a
callback URL, generate a client secret, and set `GITHUB_OAUTH_CLIENT_ID` and
`GITHUB_OAUTH_CLIENT_SECRET`. Janitor exchanges the code once, looks up the
numeric user ID, and never stores the user token.

Locally the callback returns to `http://localhost:1337/account/github/return`;
register it on a development app if you want to exercise linking. Linking is
optional: without the OAuth client the Account page shows GitHub as
unavailable and nothing else changes. Each GitHub account belongs to one
teammate at a time; connecting a different account replaces the earlier link.

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
