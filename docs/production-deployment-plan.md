# Production deployment plan

Status: code prerequisites implemented, September 5, 2026. Account configuration, production deployment, and checks with a disposable repository remain. Follow [Deploying Janitor](deployment.md) for the executable procedure.

Start with a private deployment for trusted Effectful-Tech operators at `janitor.effectful.co`. Keep the current two-Worker architecture: the website serves the SPA, and the cluster Worker serves `/api/v1/*` and runs background work. Use a fresh production database and connect repositories explicitly. Do not copy spike fixtures, queues, or durable executions.

## Current state

- The code now has a production-only remote environment, Effectful-Tech organization access, production retention policies, and a deployment-plan guard.
- Pinned backend Effect artifacts replace sibling-checkout dependencies. Clean-checkout installation, checks, website build, Worker bundling, and tests have been verified.
- CI validation and manual environment-scoped deployment workflows are included. GitHub environment protections and account credentials must be configured separately.
- Authenticated readiness is available at `/api/v1/ready`. Worker observability is enabled. Alert destinations and recovery drills remain operational launch requirements.
- The phases below remain the acceptance checklist for the first live release.

## 1. Make releases reproducible

Resolve the `alchemy.run.ts` error channel mismatch. Fix malformed mockups and formatting drift so `vp check` is a usable release gate, without disabling type checking. Verify both the website build and the actual Alchemy Worker bundle.

Replace sibling-directory dependency links with immutable packages or committed build artifacts from the required Effect revision. Record the matching Effect and Cloudflare integration revisions. Keep the existing patches pinned until their replacements pass the deployment rehearsal; do not combine launch with an untested dependency upgrade.

Add CI for a clean checkout with the pinned Node and Vite+ toolchain. Run a frozen dependency install, `vp check`, `vp test`, and the website build. Database tests need a Docker-compatible runtime. Record the commit, lockfile, toolchain, and deployment output for each release. Run production deployments serially so two jobs cannot mutate Alchemy state concurrently.

Exit condition: a clean CI runner can install, check, test, and bundle without the local Effect checkout.

## 2. Define production explicitly

Keep the stack name `Janitor` and the explicit `production` stage, owning `janitor.effectful.co`. Reject other remote stages and keep `workers.dev` disabled. Local development remains supported. Per-PR preview environments are future work.

Production owns its Neon project, Hyperdrive connection, queues, payload bucket, Workers, and Durable Object namespaces. Keep Alchemy's state backend available and restrict who can mutate it. Initially scope the production GitHub App to a disposable repository.

Provide only production plan/deploy tasks with `.env.production`. Do not support a destroy action. Retain the production database and payload storage, and reject deletion, replacement, and removed bindings before apply.

Exit condition: the reviewed plan uses production resources and routing without claiming another application's resources.

## 3. Configure identity and secrets

Allow all members of the Effectful-Tech GitHub organization through Access. Everyone admitted still has the application's full operator capabilities; defer multiple roles until the backend enforces them. Verify the configured GitHub identity provider belongs to the intended Cloudflare account.

Protect the website and all human API routes. Keep the Access bypass limited to `/api/v1/webhooks/github`, whose handler must require a valid GitHub signature. Verify missing or forged Access assertions fail and the local identity fallback cannot activate in a deployed Worker.

Provision production credentials through the deployment secret store:

| Setting                                                          | Purpose                                                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Cloudflare and Neon deployment credentials                       | Provision resources and maintain deployment state; scope to the required accounts and operations |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`                        | GitHub App authentication                                                                        |
| `GITHUB_WEBHOOK_SECRET`                                          | Authenticate webhook deliveries                                                                  |
| `GITHUB_WEBHOOK_PAYLOAD_KEY`, `GITHUB_WEBHOOK_PAYLOAD_KEY_ID`    | Encrypt retained webhook payloads                                                                |
| `OPENAI_API_KEY`, optional `OPENAI_API_URL`, `LABELING_AI_MODEL` | Optional AI provider configuration; leave repository AI consent disabled initially               |

Let Alchemy derive Access audience and database bindings. Do not copy a spike audience or expose deployment credentials to the website. Back up the payload encryption key through the secret manager and document rotation alongside encrypted-data retention.

Set the production GitHub App webhook URL to `https://janitor.effectful.co/api/v1/webhooks/github` only after ingress checks pass. Set its Setup URL to `https://janitor.effectful.co/repositories/connect/return` and enable Redirect on update. Audit the app permissions against actual API calls, and initially grant access to one pilot repository.

Exit condition: operator login, denied login, signature verification, callback state validation, and secret handling pass before connecting real repositories.

## 4. Establish data recovery and operations

Apply migrations `0001` through `0006` to a fresh production database through the existing Alchemy migration path. Never run development seeds against it. After launch, preserve applied migrations and add forward migrations starting at `0007`. Use changes compatible with the previous application version where rollback is required.

Configure Neon's restore window explicitly according to the selected service plan. Proposed initial recovery targets are at most one hour of lost configuration data and recovery within four hours. Rehearse a restore into a separate branch or project and verify the app can read policies, rules, and audit records. Confirm the achievable targets before launch. Neon's restore capability depends on its [configured history window](https://neon.com/docs/manage/projects).

Set payload retention and R2 lifecycle rules to match the application's replay and purge behavior. Database recovery also requires the corresponding encrypted payloads and keys. Record how restored database state is reconciled with queues and Durable Objects before processing resumes; replay must preserve idempotency rather than resurrect obsolete label actions.

Add a minimal authenticated readiness check for database reachability and schema compatibility. Monitor API failures, signature failures, oldest queued work, dead-letter messages, sync failures and age, cron progress, failed label writes, GitHub budget exhaustion, database connections, and provider spend. Keep repository contents and secrets out of logs. Choose an alert recipient and test delivery before launch.

Document recovery commands for retrying sync, inspecting and replaying dead-letter work, pausing automation separately from sync, and disabling AI. Configure queue retention and retries deliberately; [dead-letter queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/) need an inspection and replay procedure.

Exit condition: a restore drill and a failed-delivery recovery drill succeed, and an operator receives a test alert.

## 5. Verify with a disposable repository

Deploy the reviewed commit to production with access limited to a disposable repository. Complete recovery drills and verify the following before connecting real repositories:

- Direct SPA links, login redirects, API routing, and the exact webhook bypass path.
- An empty workspace, first connection, additional connection, cancellation, and GitHub access changes.
- New repositories remain disconnected until selected; connection creates no rules and enables no AI consent.
- Initial sync completes and the header correctly reports disabled sync.
- Create a YAML policy, save a draft, publish, reference another policy, and test against real issue/PR data.
- Bind one rule and confirm only the expected test label changes. Duplicate webhook delivery produces no duplicate action.
- Disconnect during queued and active work; verify writes stop, configuration survives, and reconnect stays paused until resumed.
- Restore revoked GitHub access, recover from database unavailability, and retry failed sync.
- Redeploy with an in-progress workflow and verify activity idempotency and completion. Review Durable Object class changes explicitly.

Exit condition: recorded evidence covers the real Cloudflare runtime and GitHub path, not only local tests.

## 6. Launch with one repository

1. Finish the disposable repository checks and recovery drills on the deployed commit.
2. Confirm readiness, Access behavior, alert delivery, and the production GitHub App configuration.
3. Grant the GitHub App access to one real pilot repository.
4. Connect one pilot repository. Wait for initial sync, create or import a reviewed policy, and test it before creating an enabled rule.
5. Enable one narrowly scoped rule and inspect its actual GitHub label changes. Keep AI consent disabled during the initial rollout.
6. Observe for 24 hours, covering cron, normal webhook traffic, a deployment, and a retry. Add repositories gradually only if queue age, sync progress, label accuracy, and errors remain healthy.

Check GitHub deliveries missed during the spike-to-production gap and redeliver relevant failures after cutover. GitHub [does not automatically redeliver failed webhooks](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries). Run an inventory refresh to establish current repository state; do not assume webhook replay alone reconstructs it.

## Rollback and launch decisions

For incorrect label behavior, pause automation immediately while retaining the repository and evidence. Pausing sync alone does not stop automation. Review any labels already changed before applying corrective actions.

Retain the previous application artifact and deployment identifiers. Roll back code only when it remains compatible with the database and durable state. Worker versions do not snapshot external storage, and some Durable Object lifecycle changes prevent [Cloudflare rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/). Prefer a forward fix when state has changed incompatibly. Never destroy production as a rollback procedure.

Before executing this plan, settle the pilot repository, alert recipient, restore window and service plan, and who owns the first-day observation. The recommended scope is a private operator deployment. Public or multi-tenant access requires a separate authorization design before launch.
