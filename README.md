# Janitor

Janitor automates GitHub labeling.

## Development

Effect dependencies use commit-pinned CI snapshots configured in `pnpm-workspace.yaml`. One root install covers every application.

```sh
vp install --frozen-lockfile
alchemy profile edit --add Infisical   # once per machine
vp run dev
```

`alchemy dev` loads shared development settings, such as the OpenRouter key for AI labeling rules, from Infisical (project `janitor`, environment `development`). Ask for a machine identity with read access, then paste its universal-auth client ID and secret into the profile prompt. `deployment/local.env` pins the local Cloudflare emulator identity over Infisical, and variables exported in your shell override both. Every integration in the development environment is optional; a missing one stays disabled.

Alchemy starts Postgres, the API on port 8787, and the website on 1337. Development needs Docker or Podman.

```sh
# Formatting, lint, type checking, and tests:
vp run check:all
```

There is no Cloudflare edge locally, so Access attributes requests to the `local-dev` identity. Local audit entries record that identity; production does not accept it.

### GitHub in development

Development talks to real GitHub through the `effect-janitor-development` App, which is installed only on [`Effect-TS/janitor-sandbox`](https://github.com/Effect-TS/janitor-sandbox). Its credentials live in Infisical's `development` environment. Without them, live GitHub access stays disabled and nothing else changes. Local workerd's built-in CA list cannot verify `api.github.com`, so the Nix shell sets `NODE_EXTRA_CA_CERTS` to the system CA bundle; outside it, set that variable yourself.

Webhooks reach your machine through the `janitor-dev` Cloudflare tunnel. `alchemy dev` runs its connector (`cloudflared`, provided by the Nix shell) when Infisical supplies `CLOUDFLARE_TUNNEL_TOKEN`. The tunnel forwards only `/api/v1/webhooks/github`. Run one connector at a time: Cloudflare splits deliveries between concurrent ones. The tunnel and its DNS record are declared in `stacks/development.ts`:

```sh
CLOUDFLARE_ZONE_ID=<effectful.co zone> vp exec alchemy deploy stacks/development.ts --stage development
```

A fresh database discovers the installation within a minute of starting. Connect the sandbox under **Connect a repository** (`/repositories/connect`) to sync its issues and pull requests. The Postgres container keeps its data across restarts; remove the container to start over.

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

Locally the callback returns to `http://localhost:1337/account/github/return`,
which the development App already registers. Linking is optional: without the
OAuth client the Account page shows GitHub as unavailable and nothing else
changes. Each GitHub account belongs to one
teammate at a time; connecting a different account replaces the earlier link.

Each repository has a separate GitHub sync switch in its Settings section.
Turning it off retains cached data and auto-labeling configuration, cancels
queued sync claims, and excludes that repository from scheduled repair, manual
sync, and sync status totals. Re-enabling requests fresh scans. Work already
fetching from GitHub may finish, but its old claim cannot publish results after
sync is disabled. Webhook journaling and projection continue to accept events.

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
