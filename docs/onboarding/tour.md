# Tour

Janitor labels issues and pull requests in connected GitHub repositories. People write policies, which are conditions over an item's facts, and rules that apply a label when a policy matches. Some conditions call an AI model. Everything else is plumbing to keep that working against GitHub's API limits.

Read `CONTEXT.md` before naming anything. It's the glossary, and the code, tickets, and tests all use its terms. If you catch yourself writing "classifier" or "AI policy", the glossary already says not to.

## Layout

```
apps/cluster     the backend: one Cloudflare Worker, Effect cluster, Postgres
apps/web         the frontend: a Foldkit app, served by its own Cloudflare Worker
packages/domain  schemas shared by both: GitHub shapes, labeling, the HTTP API
stacks/          extra Alchemy stacks, deployed by hand and rarely
alchemy.run.ts   the main stack, used for `vp run dev` and production
deployment/      local.env, the fake Cloudflare identity for local emulation
patches/         pnpm patches, each explained in patches/README.md
docs/            ADRs, agent conventions, design system, these docs
```

## The backend

`apps/cluster/src/Worker.ts` composes everything, and it's the place to start when you want to know where a piece gets wired in. It's long, but it reads top to bottom.

A GitHub event takes this path:

1. `Ingress/GitHubWebhook.ts` checks the signature and puts the delivery on a Cloudflare Queue. Payloads too big for the queue go to R2.
2. `GitHub/WebhookConsumer.ts` reads the queue and writes each delivery to the `github_webhook_delivery` journal exactly once.
3. `GitHub/ProjectWebhook.ts` projects journaled deliveries, in sequence order, into the read model: `github_entity`, `github_pull_request`, labels, and so on.
4. Labeling picks up from there.

Sync is the other way data arrives. `SyncPlanner.ts` and the `Sync*` files scan installations and repositories on a schedule and repair what webhooks missed. `GitHub/Transport.ts` makes every GitHub request, and it handles authentication, ETag caching, and the shared rate budget. If you're adding a GitHub call, go through it.

One decision shapes a lot of this code and is easy to get wrong. ADR 0006 says synchronized data is a UI cache only. Automation must read GitHub directly and must never wait on sync being fresh. If you find automation trusting the read model, that's a bug or an unfinished migration, not a pattern to copy.

`Ingress/` holds the HTTP API. Cloudflare Access sits in front of it in production. Locally there's no Access, so every request acts as the `local-dev` teammate, which is exactly why the dev tunnel forwards only the webhook path.

Migrations are numbered SQL files in `apps/cluster/migrations/`. Add the next number and never edit one that has shipped.

## The frontend

`apps/web` is a Foldkit app. It follows the Elm architecture: a model, messages, `update`, `view`, and commands for side effects. `src/main.ts` is the root, and each screen is a submodel in `src/components/`. The Foldkit agent skill in `.agents/skills/foldkit` knows the API better than any summary here.

In development, Vite proxies `/api` to the Worker on 8787. The UI fetches on page entry and on explicit actions, then refetches when a WebSocket notification says something changed. It never polls. `docs/live-updates.md` has the details.

`docs/design/DESIGN.md` is the visual system. Use its tokens and components instead of inventing new ones.

## Effect

Everything is Effect 4, pinned to a commit snapshot in `pnpm-workspace.yaml` rather than an npm release. So documentation you find online may describe a different version. When in doubt, read the source in `node_modules/effect`. Type checking runs through `@effect/tsgo`, which adds Effect-specific diagnostics on top of TypeScript's own, and `vp check` reports both.

## Infrastructure

Alchemy declares all infrastructure in TypeScript. `alchemy.run.ts` builds the main stack. Under `vp run dev` it runs locally: workerd for the Workers, a Docker container for Postgres, and local emulators for queues, R2, and Hyperdrive. Under `--stage production` the same file deploys to Cloudflare and Neon.

Production deploys only from CI, after `Check` passes on `main`. You shouldn't need to deploy anything yourself.

`stacks/development.ts` holds the shared dev webhook tunnel. `stacks/github.ts` holds the production GitHub environment and deploy token. Both were deployed once by a maintainer and only change when that setup changes.

## Working conventions

- Run `vp check` and `vp test` before you call anything done. CI runs the same two.
- Use `vp` for everything: `vp install`, `vp run <task>`, `vp exec <bin>`. The tasks live in the root `vite.config.ts`. `AGENTS.md` explains why `vp dev` and `vp run dev` differ.
- Specs and tickets are Markdown in `.scratch/<feature>/`, not GitHub issues. `docs/agents/issue-tracker.md` has the format, and `docs/agents/triage-labels.md` has the statuses.
- Architectural decisions go in `docs/adr/`. Some older ADRs describe features that have since been removed, like the sandbox runner, Slack sessions, and issue review. Check `git log` before you lean on one.
- `.agents/skills/` holds the agent skills this repo uses. They're vendored through `skills-lock.json`, so don't edit them in place.
