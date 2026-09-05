# Splitting the Workers without splitting the origin

## Shape

Two Workers, one public hostname.

`WebsiteWorker` is public. It is a `Cloudflare.Website.Foldkit` deployment
rooted at `apps/web`, so Alchemy drives the app's own Vite build and, under
`alchemy dev`, runs a real Vite dev server with HMR and the foldkit devtools
port. It owns `janitor.effectful.co`, the Access enrollment, and the static
assets. Its `main` is a small module that forwards `/api/v1/*` to the backend
over a service binding and serves everything else from `ASSETS`.

`ClusterWorker` stays where it is and keeps everything it owns today: the
Durable Object classes, the queue consumer, the crons, Hyperdrive, R2, and
every route. It loses its custom domain, its `workers.dev` surface, and its
`access` prop. Nothing reaches it except the website Worker.

The browser only ever talks to one hostname, so Access, the `CF_Authorization`
cookie, the `Sec-Fetch-Site` same-origin check, and CORS-free requests all
keep working unchanged. The assertion header Cloudflare adds at the edge rides
along on the forwarded request, so `AccessMiddleware` verifies it exactly as
it does now.

## The pieces

**The Access application moves out of the Worker.** Today it is declared
inside `ClusterWorker`'s bind phase and passed to the same Worker. The website
Worker needs to enroll in it, and the cluster Worker needs its `aud` for JWT
verification. If either Worker owned it, the two Workers would reference each
other and the graph would cycle. So the application becomes a standalone
resource both read: the website Worker takes it as `access`, and the cluster
Worker takes `access.aud` as an env value. The webhook bypass application
moves with it, since it is scoped to the public hostname.

**The forwarder.** A module in `apps/web` (paths in `FoldkitProps.main`
resolve from `rootDir`):

```ts
export default {
  async fetch(request: Request, env: { API: Fetcher; ASSETS: Fetcher }) {
    const url = new URL(request.url)
    return url.pathname.startsWith("/api/v1/") ? env.API.fetch(request) : env.ASSETS.fetch(request)
  },
}
```

That is the same routing decision `Worker.ts` makes today, moved one Worker
outward. The request object is passed through untouched, so headers, method,
and body are preserved.

**The service binding.** `env: { API: ClusterWorker }` on the website Worker
binds the cluster Worker's default entrypoint as a `Fetcher`. Under
`alchemy dev` the local provider resolves cross-Worker service bindings
through its dev registry, so both run locally and talk to each other.

**Local Access stays on the cluster Worker.** The `dev.access` stub and the
`LOCAL_DEV_AUDIENCE` binding belong on whichever Worker runs the middleware,
which is the cluster Worker. The website Worker needs neither.

**The Vite proxy goes away.** `apps/web/vite.config.ts` currently proxies
`/api` to a target, and the root `dev:web` task exists to run that server
alongside `alchemy dev`. With the website Worker owning the Vite dev server,
`alchemy dev` serves the app and the API on one local port. Both the proxy
block and the `dev:web` task can be deleted, along with the `CF_ACCESS_TOKEN`
recipe in the README, which only existed to reach a deployed stage.

## Order

1. Move the two Access applications to a shared module and thread `access`
   and `access.aud` through. No topology change yet; deploy and confirm
   nothing in Zero Trust moves.
2. Add the forwarder module and the website Worker. Keep the cluster Worker
   public for now so nothing is load-bearing yet.
3. Point the domain at the website Worker and take `domain`, `workersDev`,
   `access`, and the asset serving off the cluster Worker.
4. Delete the Vite proxy, the `dev:web` task, and the README section.

Steps 1 to 3 each deploy on their own. Step 3 is the cutover and the only
one with downtime risk.

## What landed

The shape changed twice while implementing, both times toward less machinery.

There is no forwarding module and no service binding. Cloudflare routes and
custom domains coexist on one hostname, and the more specific route wins, so
the API Worker claims `/api/v1/*` with a zone route while the website Worker
keeps the custom domain. Nothing of ours runs to make that happen, which is
what "all in Alchemy" needed. No DNS record either: the website Worker's
`domain` prop still manages it, so no zone id is required anywhere.

The Access application became hostname-level rather than Worker-destination,
since two Workers now serve the hostname and a destination application would
only cover one. That is a different Cloudflare application, so it gets a new
audience and everyone signs in once more after the cutover.

`apps/cluster/src/Ingress/Access.ts` holds both applications, the team domain,
the identity provider, and the organization. `Worker.ts` lost the
`Command.Build` step, the assets config, the custom domain, and the asset
branch in its fetch handler; it is API-only now. `alchemy.run.ts` declares the
website with `Cloudflare.Website.Foldkit`.

Two of the three things worth taking from the starter are in: the Access
application declared outside both Workers, and `strictPort` on both dev ports
(8787 and 1337).

The third does not apply here. `AlchemyContext.dev` works in the starter
because it is read in `alchemy.run.ts`, which only ever runs in the CLI. A
Worker's bind phase is also bundled into the Worker and runs at module init
inside workerd, where that service does not exist, so reading it there throws
`Service not found: alchemy/Context` on every request. `ALCHEMY_DEV` is a
`Config` value and resolves in both places, so the bind phase keeps it.

The root `dev:web` task is gone. `alchemy dev` now runs the web app's own Vite
dev server, so `vp run dev` is the whole loop. The proxy in
`apps/web/vite.config.ts` stays, standing in for the edge route that does not
exist locally.

## Verified locally

`alchemy dev` brings up both Workers. The website answers on 1337, the API on
8787, and `/api/v1/repositories` returns `200 []` through both the website's
proxy and directly. The simulated Access identity is admitted, with the
"Access is simulated" warning in the log.

`Cloudflare.Website.Foldkit` does pick up `apps/web/vite.config.ts`: the
foldkit devtools MCP relay binds 9988 and the API proxy works, so the proxy
stays where it is.

One transient to know about: on the first run after the Vite config changes,
Vite re-optimizes dependencies and restarts the dev server, which can close
the connection Alchemy uses to probe readiness. That surfaces as
`[Website] fail` with `SocketError: other side closed`. Re-running succeeds.

## What I have not verified

Nothing has been deployed. Two things to watch on the first deploy.

Whether Cloudflare accepts a route on a hostname that another Worker holds as
a custom domain. The documentation describes the two working together with
the route taking precedence, but it does not say outright that the route can
be created afterwards.

Whether a Worker with `routes` and `workersDev: false` but no custom domain
deploys cleanly. Alchemy rejects some configurations with
`WorkerVersionConfigError`.

## Costs

Two deploy units instead of one. The Access application is owned by neither
Worker, so removing both leaves it behind.

The cutover replaces the Access application, so sessions end once.
