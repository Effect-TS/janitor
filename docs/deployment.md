# Deploying Janitor

Production is the only remote environment. Per-PR previews are deferred. No production resources have been created as part of this preparation. The former `cluster-spike` stage is gone.

## 1. Prepare the accounts

Use the Cloudflare account that owns `effectful.co` and the Zero Trust organization `effectful.cloudflareaccess.com`. All members of the Effectful-Tech GitHub organization can access Janitor and have operator capabilities. Obtain the existing GitHub identity provider ID from Cloudflare Access.

Provision a Cloudflare API token scoped to the intended account and zone. It needs the operations used by Workers and routes/custom domains, Queues, R2, Hyperdrive, Access applications/policies, and the Alchemy state store. The state store uses Workers, Durable Objects, and Secrets Store. Keep that account-wide state store available for future deployments. Do not use a token with unrelated account access.

Create a Neon API key for the intended organization. The default database restore window is seven days. Confirm your Neon plan supports that window, or set `NEON_HISTORY_RETENTION_SECONDS` to a supported positive number before the first deployment.

Create the production GitHub App, initially with access to one disposable repository. The app uses repository metadata, issues and labels, pull requests and files/reviews, and check runs. Configure the corresponding read permissions and Issues write permission for label operations. Verify the installed permission set during the test-label exercise before expanding repository access. Subscribe to the webhook events represented in `packages/domain/src/GitHub/WebhookEvent`.

## 2. Prepare the local configuration

From the repository root:

```sh
cp .env.example .env.production
```

Fill every `CHANGE_ME` value. Set `JANITOR_STAGE=production`. The file is ignored by Git.

Store the app private key, webhook secret, and payload encryption key securely. `GITHUB_WEBHOOK_PAYLOAD_KEY` must be base64 for 32 random bytes. Generate it in your password manager or with a local cryptographic generator and keep a recoverable copy. Changing this key without a rotation/migration procedure makes existing encrypted data unreadable. A downloaded private key can be supplied as a quoted PEM with escaped newlines in the environment file, or as a multiline process environment value.

The website and API use `janitor.effectful.co`.

An unknown remote stage or a mismatch between `JANITOR_STAGE` and the command's stage fails. `vp run dev` still uses the local database and simulated local identity.

## 3. Validate and commit the release

Use Node 24.19.0 and Vite+ 0.3.0. The backend's pinned Effect packages are included in `vendor`; no sibling checkout is required.

```sh
vp install --frozen-lockfile
vp run check:dependencies
vp check
vp test
vp run build:web
vp run check:worker-bundle
git status --short
```

Database tests require a working Docker-compatible runtime. Commit the reviewed release. Production deployment rejects a dirty working tree. The Worker bundle check uses Alchemy's bundler without credentials; deployment still has to generate and validate the real bindings and Durable Object exports.

An older development checkout may contain a manually created `apps/cluster/node_modules/effect` link to the sibling checkout. The dependency check detects that case and explains how to remove the stale link before reinstalling. Fresh CI installations do not need this cleanup.

## 4. Review and deploy production

```sh
vp run production:plan
vp run production:deploy --yes
```

Review the plan before running the second command. Expect production-owned resources and `janitor.effectful.co`. Stop if it tries to claim another application's resources. The first use of Alchemy on an account can require initialization of its shared state store. Approve that only for the intended account.

The deploy command replans against current state. It records the commit, lockfile hash, toolchain version, and resource actions in `.alchemy/releases`. A per-stage local lock prevents overlapping commands on this checkout. If a process is forcibly killed, first verify no deployment is running before removing its `.alchemy/deploy-<stage>.lock` directory.

Open `https://janitor.effectful.co` and log in. Then open `https://janitor.effectful.co/api/v1/ready` in the same browser. Expect `{"status":"ready"}`. A database/schema failure returns HTTP 503 without database details. Verify that a user outside the Effectful-Tech organization cannot enter and that an unsigned webhook request is rejected.

The production command checks the actual plan immediately before apply, even with `--yes`. It rejects resource deletions, replacements, and removed bindings. There is no production destroy task. Use these tasks instead of calling `alchemy deploy` directly, which bypasses the application-specific guard.

Production Neon and the encrypted payload bucket have retain policies. Retain prevents physical deletion but does not prevent a resource from leaving Alchemy's state. It is not a backup, and it does not replace plan review. The payload bucket keeps the existing 14-day lifecycle rule; recovery must happen while the necessary payloads and encryption keys still exist.

## 5. Verify with a disposable repository

Set these in the production GitHub App registration:

- Webhook URL: `https://janitor.effectful.co/api/v1/webhooks/github`
- Webhook secret: the matching `GITHUB_WEBHOOK_SECRET`.
- Setup URL: `https://janitor.effectful.co/repositories/connect/return`.
- Enable **Redirect on update** for the Setup URL.

GitHub's [Setup URL](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url) is separate from an OAuth callback. If GitHub does not redirect back, use Refresh repositories in Janitor.

The connection page fetches available repositories directly from GitHub. Connecting and disconnecting update immediately; content sync runs afterward. Keep Hyperdrive query caching disabled: its cached reads are not invalidated by writes and can hide connection changes or return outdated workflow state.

Check a signed webhook delivery succeeds. In Janitor, connect only the disposable repository and wait for initial sync. Create a YAML policy, save a draft, publish it, reference another policy, and test against an issue or PR. Enable one test rule and verify its exact GitHub label changes. Exercise disconnect, paused reconnect, and explicit resume. Leave AI consent disabled.

Before connecting real repositories, rehearse a database restore into a separate branch/project and an in-flight workflow redeployment using disposable repository work. Confirm the restored database, queued envelopes, retained payloads, and Durable Objects can be reconciled without replaying obsolete label actions. Choose an alert recipient and configure monitoring for errors, dead-letter backlog, sync age, and database availability. Worker observability is enabled in code; notification destinations and account-level alerts still need configuration.

## 6. Connect a pilot repository

After the disposable repository checks and recovery drills pass, grant the GitHub App access to one real pilot repository and connect it explicitly. Test policies and enable one narrow rule. Observe for 24 hours before adding more repositories. Review missed GitHub deliveries during cutover; GitHub [does not automatically retry failed deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries).

## GitHub Actions deployment

The Check workflow runs installation, checks, tests, and both build checks. The Deploy workflow is manually dispatched with either `plan` or `deploy`; all jobs target production and are serialized.

Create a GitHub environment named `production`. Configure production required reviewers and restrict eligible deployment branches/tags before using the workflow. Add the environment variables and secrets referenced in `.github/workflows/deploy.yml`; they match `.env.example`. The workflow creates an environment file containing only the stage and reads credentials from GitHub environment secrets. It uploads sanitized apply-attempt records, never the raw Alchemy state or environment files. Confirm success from the job result, not merely the presence of a record.

The workflow omits AI credentials intentionally. Add them to the environment and workflow only when AI classification is ready to enable and observe.

## Recovery

For incorrect labels, pause automation in Settings. Sync is an independent control; turning sync off does not stop labeling. Preserve the audit trail and inspect labels already changed before correcting them.

Retain the previous release commit and deployment identifiers. A code rollback must remain compatible with database and durable state. Cloudflare documents [rollback limits](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/), including Durable Object lifecycle changes. Prefer a forward fix when storage changes cannot be reversed safely.

No destroy action is supported. Preserve the shared Alchemy state store and production data during recovery.
