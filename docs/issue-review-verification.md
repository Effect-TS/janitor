# Issue review production verification

Ticket 13 prepares configuration eligibility. It does not deploy Janitor or opt a live repository in. The deployment gate defaults to off, independently of repository opt-in.

## Automated coverage

The backend integration suites apply every SQL migration to fresh Postgres 18 containers. Review tests use real admission, scheduler, Entity handlers, persisted application state, and action workflows, with an in-memory workflow engine and controlled external GitHub, model, and workspace services. They drive action delivery explicitly. They do not prove deployed cluster failover or live provider behavior.

The combined reproduction/publication scenarios script a sandbox assertion result through the workspace interface; they do not execute repository tests themselves. `Review/Workspace.test.ts` separately executes a real Node.js test against local Git revisions and checks failure, success, integrity, and timeout behavior. Deployed container execution remains a smoke test.

| Requirement                                                                                                     | Evidence                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Deployment gate and separate repository opt-in                                                                  | `apps/cluster/test/Deployment.test.ts`, `apps/cluster/test/Review/Review.test.ts`                                             |
| Free-form mention, denial of quoted/bot/PR/edited/unauthorized inputs, delivery replay                          | `apps/cluster/test/Review/Review.test.ts`, `packages/domain/test/Review/`                                                     |
| Per-issue ordering, concurrent issues, cancellation, closure, repository controls                               | `apps/cluster/test/Review/Review.test.ts`                                                                                     |
| Model actions, observed evidence, reproduction, publication, explicit saved-result publication                  | `apps/cluster/test/Review/Investigation.test.ts`                                                                              |
| Runner recovery, completed action reuse, workspace loss, original deadline, cancellation during pending actions | `apps/cluster/test/Review/Investigation.test.ts`                                                                              |
| Uncertain branch/PR/comment responses, partial publication, human edits, retries without model work             | `apps/cluster/test/Review/Investigation.test.ts`                                                                              |
| Expiry, retained receipts and ownership, later reuse, disconnect fencing                                        | `apps/cluster/test/Review/Investigation.test.ts`                                                                              |
| Credential-free provisioning and sandbox execution                                                              | `apps/cluster/test/Review/Workspace.test.ts`, `packages/alchemy/test/`                                                        |
| Forbidden patches and reproduction assessments                                                                  | `apps/cluster/test/Review/Patch.test.ts`, `apps/cluster/test/Review/Reproduction.test.ts`                                     |
| Agent-authored output, no frontend references, evidence links and mention validation                            | `apps/cluster/test/Review/Investigation.test.ts`, `apps/cluster/test/Review/Comments.test.ts`, `packages/domain/test/Review/` |
| Authenticated frontend publication and cancellation                                                             | `apps/cluster/test/Ingress/Review.test.ts`, `apps/web/test/components/reviews.test.ts`                                        |
| Direct issue/PR labeling during cache failure, absent/stale cache, sync off, access restoration and transfer    | `apps/cluster/test/Labeling/CacheIndependence.test.ts`                                                                        |
| Slack repository access independent of cache readiness                                                          | `apps/cluster/test/Slack/Repositories.test.ts`                                                                                |

Review tools expose no Slack or labeling operations. Publication uses dedicated GitHub comment and draft-PR services. Labeling remains a separate webhook consumer; review findings do not feed it.

## Reproducing local checks

Run `vp install`, then `vp check` and `vp test` from the repository root. `vp run check:all` combines the last two. Container-backed tests need a working Docker-compatible runtime and the Postgres image; frontend component tests use happy-dom, not a live browser. A skipped or unavailable environment check is not a pass.

Focused backend acceptance checks:

```sh
vp test apps/cluster/test/Review apps/cluster/test/Ingress/Review.test.ts apps/cluster/test/Labeling/CacheIndependence.test.ts apps/cluster/test/Slack/Repositories.test.ts
```

## Recorded local results

On 2026-09-18, `vp install` succeeded. `vp check --fix` passed with 0 errors and 347 existing warnings. The full `vp test` run passed 790 tests across 125 files, with no skipped tests. After review fixes, `vp test apps/cluster/test/Review/Investigation.test.ts` passed all 110 tests. The initial focused review, cache-independence, and Slack access run passed 120 tests.

### Standards review

One finding was resolved: new recovery assertions now read the public history interface instead of internal persistence. No remaining findings. The restart test also seeds its own repository so it can run independently.

### Spec review

No findings. The implementation preserves deployment gating and repository opt-in; the documented live smoke tests remain outstanding.

## Deployment smoke tests still required

These checks require a separately authorized deployment and a disposable public repository. They have not been run as part of ticket 13.

1. Confirm all migrations, the review container image and namespace, cluster persistence, outbox processing, and retention cron are installed. With the deployment flag absent, verify settings cannot enable review. Set the flag only through an authorized configuration change, then verify repositories remain opted out until explicitly enabled.
2. Configure the agent model and GitHub App. Verify public checkout, package installation, and a real failing reproduction test in the deployed image. Inspect sandbox environment and Git configuration without printing secret values; no GitHub, Slack, or model credential may be present. Confirm Node.js, pnpm, and outbound package access.
3. Opt the disposable repository in with dry-run on. Post an authorized free-form mention. Verify the recorded commit, findings, test output, and proposed patch in Reviews and no GitHub publication. Link a different authorized publisher, publish that result, and confirm one draft PR and one issue summary without another model call. Refresh and repeat the action to check deduplication.
4. With automatic publication enabled for a new invocation, exercise the same reproduction path. Queue two comments on one issue and another on a different issue. Confirm ordering and independent progress. Redeliver a webhook and confirm no new run.
5. Restart a runner during a pending action with its container intact. Confirm the original deadline and no repeated completed model call. Separately destroy an unfinished workspace; confirm interruption, retained observations, and no automatic reconstruction. Cancel while a model or sandbox action is pending and confirm work stops.
6. Exercise permission revocation, edited/deleted invocations, issue closure, review disablement, repository pause, and access loss. Confirm later writes stop and restoring controls does not revive cancelled work. Account for writes already accepted before the control change.
7. Inject lost responses around branch, PR, and comment writes in a controlled environment. Verify reconciliation, partial and unresolved outcomes, and no duplicate artifacts. Edit an owned PR by hand and verify it is preserved. Retry saved publication without model work.
8. In a disposable database, cross the 14-day boundary and run retention. Verify detailed rows and workspaces disappear, expired publication is denied, webhook replay remains deduplicated, and later review recognizes owned artifacts and intervening human edits.
9. Disable or fail cache refresh. Confirm fresh issue/PR labeling, review admission through publication, and Slack repository access still work. Verify real access loss still blocks all three. Confirm review does not produce Slack messages or labeling actions.

Record deployment version, environment, observed artifacts, and results for each smoke test before claiming live readiness. `vp run plan:prod` and `vp run deploy:prod` were not run for this ticket.
