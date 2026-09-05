# Cloudflare Access in local development

## The problem

Every human API route sits behind `AccessMiddleware`. It reads the
`Cf-Access-Jwt-Assertion` header that Cloudflare's edge attaches after a
person logs in, verifies it against the team's signing keys, and answers 401
otherwise. That is the right behaviour in production and it makes local
development impossible, in two separate ways.

`vp run dev` runs the Worker in a local workerd through `alchemy dev`. There
is no edge in front of it, so no request ever carries the assertion header,
and every `/api/v1` call gets an empty 401. The Worker starts, the UI loads,
nothing works.

The web dev server has the opposite problem. Its Vite proxy sends `/api` to
`https://janitor.effectful.co` by default. Production is behind Access, so
a proxied request with no `CF_Authorization` cookie gets a 302 to the login
page, which the proxy hands back to the app as HTML. The only way to make
that work today is to paste a cookie out of a browser, and then the local UI
is editing production rules. I don't want a `Save` button in a half-finished
branch pointed at the live configuration by default.

Neither problem is about Access itself. Access does its job. The gap is that
we have no story for "who is the user" when there is no edge.

## What I am not going to do

No second login system. The design doc is clear that Janitor does not run its
own session or OAuth flow, and a local-only login would be a third code path
to keep honest. No environment variable that turns the JWT check off, either.
A flag named `SKIP_AUTH` is a flag someone will eventually set in the wrong
place.

## The plan

### 1. Declare the local identity, and only under `alchemy dev`

Alchemy already has the mechanism. A Worker's `dev.access` option lowers a
stub Access context into the local runtime, and the stub is inert on deploy.
That alone is not enough of a guarantee for me, because it relies on Alchemy
behaving, and the middleware would still contain a code path that trusts a
stub. So the plan gates it twice.

The first gate is at build time. Alchemy exports `ALCHEMY_DEV`, a config
value that only the `alchemy dev` command sets on its own process. `deploy`,
`plan`, and the deployed runtime all leave it unset. The Worker's bind phase
in `apps/cluster/src/Worker.ts` reads it and branches:

```ts
const isDev = yield * ALCHEMY_DEV
const localDev = isDev ? { audience: "local-dev", email: "dev@janitor.local" } : undefined

return {
  // ...
  env: {
    ACCESS_AUD: access.aud,
    LOCAL_DEV_AUDIENCE: localDev?.audience ?? "",
  },
  dev: {
    port: 8787,
    ...(localDev && {
      access: { aud: localDev.audience, identity: { email: localDev.email } },
    }),
  },
}
```

On a deploy, `localDev` is `undefined`. No `dev.access` is declared, and the
`LOCAL_DEV_AUDIENCE` binding is an empty string. The deployed Worker carries
no audience the fallback could ever match. On `alchemy dev` both are set from
the same literal, so they cannot drift apart.

The second gate is the audience string itself. Real Access audiences are 64
hex characters. `local-dev` can never come out of Cloudflare, so a request
whose Access context carries it can only have come from the stub.

### 2. Teach the middleware about the stub, narrowly

`AccessMiddleware` keeps its current shape. When the assertion header is
present, it is verified exactly as today, no matter where the Worker runs. The
change is what happens when the header is absent.

Today that is an immediate 401. After this change the middleware yields
`Cloudflare.Access.Context` and compares it with the `LOCAL_DEV_AUDIENCE`
binding read at init. Four cases:

- The binding is empty. This is every deployed Worker. 401, as today, without
  even looking at the context. The stub path is unreachable in production.
- Context is `undefined`. The request did not pass through Access at all. 401. This is what a Worker sees if someone reaches it around the edge.
- Context is defined and its `aud` equals the binding. Admit the request with
  a synthetic identity: issuer `local-dev`, subject the stub's email,
  `expiresAt` one hour out. Log at warning level once per process so the
  stub is never silent.
- Context is defined with any other `aud`. 401.

The middleware receives the dev audience as a constructor argument from
`Worker.ts`, the same way it receives the real one. It does not read
environment on its own and it has no built-in default.

Audit rows written during local development will show issuer `local-dev`.
That is a feature. If one of those ever appears in the production audit
table something has gone badly wrong, and it will be obvious.

### 3. Point the web dev server at the local Worker

Change the proxy default in `apps/web/vite.config.ts` from production to
`http://localhost:8787`, matching the port pinned in step 1. `changeOrigin`
stays, and `Sec-Fetch-Site` still reads `same-origin` from the browser, so
the write routes' same-origin check keeps passing.

Keep `JANITOR_API_ORIGIN` as the override for pointing the UI at a deployed
stage. That path needs a real Access token, and the honest way to get one is
`cloudflared`, not a cookie jar:

```sh
cloudflared access login https://janitor.effectful.co
cloudflared access token --app https://janitor.effectful.co
```

The proxy reads `CF_ACCESS_TOKEN` and sends it as the `cf-access-token`
header, which Access accepts in place of the cookie for self-hosted
applications. The token expires with the session, eight hours at most, and it
never lands in a file the repo knows about. `.env` is already gitignored and
loaded by direnv, so it goes there, and the README only ever mentions the
variable name.

Two dev tasks in `vite.config.ts` at the root, so nobody has to remember
which package to filter:

- `dev`: unchanged, runs `alchemy dev`.
- `dev:web`: runs the Vite dev server in `apps/web`.

Running both is the normal loop. Running only `dev:web` with
`JANITOR_API_ORIGIN` set is the "look at real data" loop.

### 4. Tests

`apps/cluster/test/Ingress/Middleware.test.ts` gets five cases on top of the
existing ones. Each one builds the router with a fake `WorkerExecutionContext`
so the Access context is whatever the test says.

1. No header, no context: 401. This is the case that exists today and must
   not regress.
2. No header, context with the dev audience, middleware built with that
   audience: 200, and the route sees issuer `local-dev`.
3. No header, context with the dev audience, middleware built with an empty
   audience: 401. This is the deploy configuration, and it proves the stub
   is dead without the build-time flag.
4. No header, context with a hex audience: 401.
5. Header present, context with the dev audience: the verifier is called and
   its verdict wins. A bad assertion is still a 401 even when the stub is
   live.

Cases 3 and 5 are the ones I care most about. The stub must never become a way to
skip verification of a token that was actually supplied.

### 5. Docs

Replace the starter-template README development section with the two-task
loop above, the `CF_ACCESS_TOKEN` recipe, and one sentence saying local
requests are attributed to `local-dev`. Add a short "Local development"
paragraph to the authentication section of
`docs/github-synchronization-design.md` so the design and the code agree.

## Order and size

Steps 1 and 2 land together in one commit with the tests from step 4. They
are small, perhaps eighty lines including tests. A deploy to the spike stage
afterwards, followed by a request without a header, should still get a 401.
That is the manual check that the build-time gate held. Step 3 is a separate commit
because it touches a different app and can be reverted on its own. Step 5
rides with step 3.

## Things to check before starting

`alchemy dev` still evaluates the `Cloudflare.Access.Application` resources
in `Worker.ts`. I expect it to adopt the existing applications rather than
create new ones, but I have not watched it do so, and a dev run that creates
a second `Janitor` application or moves the webhook bypass would be worse
than the bug this plan fixes. Run `vp run dev` once with the Cloudflare
dashboard open and confirm nothing in Zero Trust changes. If it does, the fix
is to give the dev stage its own application names before anything else.

The `WorkerExecutionContext` service the middleware will read is provided by
Alchemy's fetch adapter. The router in `Worker.ts` is wrapped with
`cluster.provide(handler)`, and I have not confirmed that the execution
context survives that wrapping. If it does not, the fallback in step 2 reads
`env.ALCHEMY_DEV_ACCESS` directly through `WorkerEnvironment` instead, with
the same audience guard. Less pretty, same safety.

## What landed

Steps 1 to 5 are implemented as described, with two deviations worth
knowing about.

A route middleware cannot declare a per-request service dependency, so the
middleware captures `WorkerExecutionContext` when its layer is built. Alchemy
provides a deferred one at init whose `access` looks up the live per-request
context from the calling fiber, which gives the same result. The
`RuntimeContext` colour on that accessor is satisfied with Alchemy's empty
phantom layer; the real service is on the handler fiber regardless.

The local identity is configured through a small `AccessMiddlewareConfig`
service rather than a function argument, because the middleware is a layer.
`makeRoutesLayer` takes the option and `Worker.ts` fills it from the
`LOCAL_DEV_AUDIENCE` binding.

The first open check answered itself on the first `alchemy dev` run, and not
the way I hoped. `alchemy dev` uses stage `dev_$USER`, and it tried to create
a second Access application named "Janitor" in the real account. Cloudflare
rejected it: a self-hosted application must be born with a domain or a
destination, the application here has neither, and Alchemy deliberately skips
enrolling a Worker that runs locally, because a local Worker has no cloud
script and Access cannot front localhost. The dev stage's state also already
claimed the webhook bypass application, which points at the production
hostname.

So the bind phase now declares neither Access application under
`alchemy dev`. Access is a deploy-time concern; locally the `dev.access` stub
stands in for the edge. `ACCESS_AUD` is empty there, which is what the
middleware wants, since the local audience is the one in play. The local
Worker provider forces `domain: undefined`, so the custom domain is not
created in the dev stage either.

The second check, whether a deployed Worker still answers 401 to a
header-less request, is still open.
