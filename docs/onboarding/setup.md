# Setup

This takes a fresh clone to a local Janitor that talks to real GitHub. Each step ends with a check. Run the check, and don't continue until it passes.

Steps marked "developer" need a human. Agents should explain what's needed, wait, then verify.

## 1. Tools

Janitor develops inside a Nix flake shell, loaded by direnv. The shell provides Node 24, pnpm, `cloudflared`, Playwright's browsers, and a CA bundle that local workerd needs to reach GitHub. Skipping Nix works, but then you supply all of that yourself, and the CA bundle is the one people forget. See the end of this section.

You need these on the machine:

- Nix with flakes enabled, and direnv hooked into your shell.
- `vp`, the Vite+ CLI. Install it with `curl -fsSL https://vite.plus | bash`, then open a new shell.
- Docker or Podman. `alchemy dev` runs Postgres in a container, and the tests start their own through Testcontainers. With Podman, the Docker-compatible socket must be on, because Testcontainers looks for `/var/run/docker.sock` or `DOCKER_HOST`.

Then, from the repo root:

```sh
direnv allow
```

Check:

```sh
node --version          # v24 or later
cloudflared --version
echo "$NODE_EXTRA_CA_CERTS"   # a path ending in ca-bundle.crt
docker info >/dev/null && echo containers ok
vp --version
```

Without Nix, install Node 24+ and `cloudflared` yourself and export `NODE_EXTRA_CA_CERTS` pointing at your system CA bundle. On most Linux distros that's `/etc/ssl/certs/ca-certificates.crt`, and on macOS you can export the keychain roots to a file. Skip this and every GitHub call from the local Worker fails with a TLS error.

## 2. Dependencies

```sh
vp install --frozen-lockfile
```

This also applies the patches in `patches/`. One of them fixes Alchemy's Docker provider under Podman, so a stale `node_modules` can break `vp run dev` in confusing ways. Rerun this after every pull.

Check:

```sh
vp run check:all
```

This runs format, lint, type checks, and the full test suite, which takes about a minute. Expect 0 errors. The lint warnings are a known baseline. Test failures that mention containers usually mean the Docker socket isn't reachable, so go back to step 1.

## 3. Infisical (developer)

`alchemy dev` reads the shared development settings from Infisical: project `janitor`, environment `development`. That's where the development GitHub App's key, the webhook secret, and the tunnel token live.

The developer needs the machine identity from [the access list](README.md#access-to-request-first). Then they run this themselves and paste the client ID and secret into the prompt:

```sh
vp exec alchemy profile edit --add Infisical
```

Agents shouldn't run this one or ask for the values. The prompt is interactive and the secret has no business in a chat log.

Check that the profile exists without printing it:

```sh
ls ~/.alchemy/profiles/default && echo profile ok
```

If Infisical isn't configured, Janitor still starts. GitHub access just stays off, and the Connect page shows nothing. Every integration in development is optional on purpose.

## 4. Run it

Make sure no other Janitor dev server is running. Only one process can bind port 8787, and the webhook tunnel always forwards to 8787. If another worktree holds the port, this one starts half broken. The quick test:

```sh
ss -ltn | grep -E ':(8787|1337)\b' || echo ports free
```

On macOS, use `lsof -iTCP:8787 -sTCP:LISTEN` instead. Then start it:

```sh
vp run dev
```

The first run builds the Postgres image, so give it a minute. Alchemy prints a plan. Every line should end in `created` or `updated`. Any `fail` means something's wrong, and [troubleshooting.md](troubleshooting.md) covers the ones we've seen.

Check:

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:1337/          # 200
curl -s http://localhost:1337/api/v1/repository-connections/available    # JSON
grep -l "Registered tunnel connection" .alchemy/log/dev_*/WebhookTunnel/*.log
```

The last command should print a log file. If it prints nothing, the tunnel didn't start, which usually means the Infisical step isn't done.

## 5. Connect the sandbox

The local database starts empty. Within about a minute, Janitor's scheduled discovery finds the development App's installation. The App is installed only on `Effect-TS/janitor-sandbox`, so that's the only repository you'll ever see locally.

Check that discovery ran:

```sh
curl -s http://localhost:1337/api/v1/repository-connections/available
```

The response should list `janitor-sandbox` with `"connected":false`. An empty list after two minutes means GitHub calls are failing. Look in `.alchemy/log/dev_*/ClusterWorker/` for the reason.

Next, the developer opens http://localhost:1337/repositories/connect and clicks **Connect repository**. Run the same curl again. It should now show `"connected":true` and, once the first sync finishes, `"syncState":"ready"`.

## 6. Prove webhooks work (developer)

The developer opens an issue in [the sandbox](https://github.com/Effect-TS/janitor-sandbox/issues), or edits an existing one. GitHub sends the webhook to `janitor-dev.effectful.co`, and the tunnel forwards it to the local Worker.

Check the worker log first:

```sh
grep -A2 "Projected GitHub webhook delivery" .alchemy/log/dev_*/ClusterWorker/*.log | tail -6
```

Then the database. The container name lives in this worktree's Alchemy state:

```sh
pg=$(grep -rho 'janitor-postgres-[0-9a-f]\{64\}[a-z0-9-]*' .alchemy/state | head -1)
docker exec "$pg" sh -c 'psql -U "$POSTGRES_USER" -d "${POSTGRES_DB:-$POSTGRES_USER}" \
  -c "select number, kind, title, state from github_entity order by number"'
```

The new issue should be there. Use `podman` instead of `docker` if that's what you have.

That's it. The developer is set up. Point them at [tour.md](tour.md) next.

## Sharing the tunnel

There's one development App and one tunnel for the whole team. When two people run `vp run dev` at the same time, Cloudflare splits webhook deliveries between them, so each person sees roughly half the events. Nothing breaks, but your local data drifts from GitHub. If you're testing webhook behavior, tell the team. Otherwise, use the repository's sync button to pull current state from GitHub.

## Starting over

The Postgres container keeps its data across restarts. To get a fresh database, stop `vp run dev`, remove the container, and start again:

```sh
docker rm -f "$(grep -rho 'janitor-postgres-[0-9a-f]\{64\}[a-z0-9-]*' .alchemy/state | head -1)"
```

Each worktree has its own container and its own `.alchemy/` state, so removing one doesn't touch the others.
