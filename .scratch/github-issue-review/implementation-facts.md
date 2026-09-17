# Verified implementation facts

Inspected during the design interview. These are existing capabilities and gaps, not evidence that the proposed review workflow is implemented.

## Invocation and authorization

- `apps/cluster/src/Ingress/GitHubWebhook.ts` verifies signatures and journals supported repository events with an outbox.
- `packages/domain/src/GitHub/WebhookEvent/Comment.ts` supports created, edited, and deleted issue comments and distinguishes PR conversation comments. Its decoded payload omits the editor identity and prior body.
- `apps/cluster/src/GitHub/ProjectWebhook.ts` does not currently dispatch comment-based review. Repository identity uses GitHub's stable repository ID across rename and transfer.
- No existing collaborator-permission helper was found. GitHub's [permission endpoint](https://docs.github.com/en/rest/collaborators/collaborators#get-repository-permissions-for-a-user) accepts installation tokens with metadata read access and exposes effective base permission independently of custom role names.
- Human settings APIs use Cloudflare Access and active Janitor membership. Connection and rule changes do not currently require a human GitHub repository-admin check. GitHub linking establishes user identity but does not itself grant repository permission.

## Synchronization migration

- `Labeling/SyncIntegration.ts`, `SnapshotHandoff.ts`, and `ReconcileEntity.ts` dispatch and qualify labeling using verified synchronized snapshots.
- Migration `0030_repository_access_lifecycle.sql` makes `repository_block_reason` depend on synchronization health/readiness. `Slack/Repositories.ts` uses that predicate.
- Migration `0021_github_access.sql` also includes installation `sync_enabled` in the access predicate. Lifecycle triggers reset synchronization generations/readiness and remove pending work. Removing only the visible readiness checks would leave hidden coupling.
- `RepositoryActivity.ts` serializes effects with local repository state changes, but currently permits the effect when the repository row is absent. It does not enforce invoker authority, review configuration, patch scope, or current remote access. It is not an unchanged review-publication guard.

## Workflow and sandbox

- Installed Effect Cluster exposes addressable `Entity` definitions, mailbox handlers, and opt-in persisted RPC messages. Agent state still needs explicit persistence. The existing cluster Workflow engine executes durable workflows; this supports entity-owned action workflows without modeling the complete agent as a Workflow. No direct `Entity.make` use was found in the current application source during this inspection.

- `WorkflowDispatcher.ts` provides outbox dispatch, leased claims, and backoff. `Labeling/RuleTestJob.ts` and `ReconcileEntity.ts` use Effect Workflow and named Activities with persisted results.
- Installed Effect is `4.0.0-rc.112`. Its Activity source states that completed results are memoized and interrupted Activity bodies may execute again. External-write reconciliation and fresh checks belong inside each write attempt.
- ADR 0005 describes current Slack sessions in the API Worker. Historical runner ADRs do not describe the current Slack implementation.
- `Slack/SessionObject.ts` enables sandbox internet access. The current image in `packages/alchemy/src/Cloudflare/AI/SandboxContainerRuntime.ts` includes Node 24 and tools such as Git and ripgrep; pnpm provisioning is not explicit.
- `packages/alchemy/src/Git/Command.ts` supplies credentials to sandbox Git through process environment. Review must preserve the accepted zero-credential sandbox boundary instead.
- Existing checkouts are ephemeral. Current Slack repository tools do not establish durable reproduction storage or PR publication recovery for this feature.
- The rule editor and `Labeling/RuleTestJobs.ts` provide asynchronous preview and durable job patterns, not an existing review history or dry-run publication feature.

## CI facts and limits of inspection

- Local `check.yml` runs for PRs targeting main, pushes to main, and manual dispatch. It uses a hosted runner, declares contents read, and references no explicit secrets. `deploy.yml` runs on main pushes or manual dispatch, checks the main ref, and uses a production environment with secrets.
- Neither checkout disables credential persistence. No local pull_request_target, workflow_run, reusable-workflow, or local-action usage was found. Live organization policies, environment protections, and external CI were not inspected.
- GitHub documents draft-capable PR triggers, independent push triggers, target-branch PR filters, and privileged downstream execution risks in its [workflow event reference](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows).
- Current [trigger documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow) describes approval-required runs for certain GITHUB_TOKEN-generated PR events; installation tokens can trigger workflows without that approval. Blanket token-recursion suppression is not a safety assumption.
- Same-repository App publication has no documented general fork-equivalent isolation guarantee. Token permissions do not withdraw separately supplied secrets. The accepted MVP delegates CI safety to repository administrators.
