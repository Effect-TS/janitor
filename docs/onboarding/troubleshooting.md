# Troubleshooting

Each entry here cost someone an afternoon. Find the symptom, apply the fix. If yours isn't listed, the logs are the next stop:

```
.alchemy/log/dev_<user>/ClusterWorker/   the backend Worker
.alchemy/log/dev_<user>/Website/         Vite and the website Worker
.alchemy/log/dev_<user>/WebhookTunnel/   cloudflared
```

Each run starts new files, so read the newest one.

## "Could not bind to port 8787 (already in use)"

The plan shows `ClusterWorker` failing, followed by a long list of bindings failing with it. Another `alchemy dev` holds the port, usually from a different worktree. Find it:

```sh
ss -ltnp | grep ':8787\b'
```

Then read `/proc/<pid>/cwd` to see which worktree it belongs to. Stop that session, then restart yours. An agent shouldn't kill someone else's dev server without asking.

Running both on different ports doesn't help much. The tunnel forwards webhooks to 8787 no matter what, so whoever holds 8787 gets the events.

## "Docker.image.inspect ... image not known"

Podman phrases a missing image differently from Docker, and stock Alchemy only recognizes Docker's wording. `patches/alchemy@*.patch` fixes it. If you still see this error, the patch wasn't applied, so run `vp install` again.

## "TLS peer's certificate is not trusted"

This one shows up in the ClusterWorker log. In the UI it looks like "GitHub request failed", and the Connect page stays empty. Local workerd ships its own CA list, and that list is missing the Sectigo root that `api.github.com` uses now. Alchemy hands `NODE_EXTRA_CA_CERTS` to workerd, and the Nix shell sets it.

Check `echo $NODE_EXTRA_CA_CERTS`. If it's empty, direnv didn't load the flake. Run `direnv allow` or `direnv reload`, then restart `vp run dev` from that shell. A dev server started before the variable existed won't pick it up.

## The browser shows "Application crash: Schema validation failed"

This happens when two copies of Effect get loaded in the browser. Foldkit's Vite plugin keeps `foldkit` out of prebundling, and foldkit imports the `effect` barrel. Unless that barrel gets prebundled too, foldkit ends up with a second Effect, and every message with an `Int` field fails to construct. `apps/web/vite.config.ts` includes `effect` in `optimizeDeps` for this reason. Don't remove it.

If it comes back after a dependency bump, look in the browser's network panel. Any request for `/@fs/.../effect/dist/...` next to `/node_modules/.vite/deps/...` means a second copy. Deleting `apps/web/node_modules/.vite` forces a clean prebundle.

## "Live GitHub access is disabled without development App credentials"

Infisical didn't supply the development App's key, so setup step 3 isn't done or the profile is broken. Re-run `vp exec alchemy profile edit --add Infisical`. Check with a maintainer that your machine identity can read the `development` environment.

## The Connect page is empty

Work through these in order:

1. Wait two minutes. Discovery runs once a minute.
2. Look for TLS or authentication errors in the ClusterWorker log. Both are covered above.
3. Make sure the request actually reached your Worker. If port 8787 belongs to another worktree, your UI talks to your Worker, but that Worker never started.

## Webhooks don't arrive

1. Confirm the tunnel is up. Look for `Registered tunnel connection` in the WebhookTunnel log.
2. Confirm the public side works. `curl -i -X POST https://janitor-dev.effectful.co/api/v1/webhooks/github` should return 400, because the signature is missing. A 530 means no connector is running anywhere. Every other path should return 404.
3. Someone else might be running `vp run dev` too. Cloudflare splits deliveries between connectors, so each of you gets a share. Ask around.
4. Check the App's "Recent Deliveries" page on GitHub. It shows each delivery's response code. A maintainer can redeliver from there.

## Tests fail before running anything

The backend tests start a Postgres container through Testcontainers. Make sure `docker info` works in the same shell. With Podman, enable the Docker-compatible socket. On NixOS that's `virtualisation.podman.dockerSocket.enable`, and elsewhere it's `systemctl --user enable --now podman.socket` plus `DOCKER_HOST`.

## Deploying `stacks/development.ts` fails with "Unauthorized"

Only maintainers deploy this stack. Your Alchemy profile needs to point at the Effectful Cloudflare account and include the `argotunnel` and `dns` scopes, read and write. The default profile on most machines points somewhere else.
