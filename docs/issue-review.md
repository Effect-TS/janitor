# Operating issue review

Issue review investigates a newly posted, authorized `/janitor` command in a GitHub issue comment. It can publish a draft PR containing a failing reproduction test and maintain one summary comment on the issue. It does not fix production code, apply labels, feed labeling, or send Slack notifications.

## Configuration and repository opt-in

Production configuration is supported after the synchronization-as-cache migration and the complete review path. Apply all database migrations through `0050_issue_review_retention.sql`, using the normal deployment migration process. The [verification record](issue-review-verification.md) describes local coverage and the remaining live checks. Deployment and live repository enablement require separate authorization.

`JANITOR_ISSUE_REVIEW_ENABLED=true` makes review available in a deployed environment. It defaults to false. The temporary `JANITOR_ISSUE_REVIEW_DEVELOPMENT` variable is no longer read; existing users must explicitly choose the new setting. No checked-in deployment configuration enables review. Local `alchemy dev` exposes review controls, but its default composition disables live GitHub operations.

Configure the existing agent model with `JANITOR_AGENT_RUNNER_MODEL_API_KEY`, an OpenRouter credential, and optionally `JANITOR_CHAT_MODEL`. Review shares that model configuration with Slack sessions, independently of the labeling model. Configure GitHub App authentication and webhook delivery through the normal deployment setup. The App needs repository access to read evidence and write contents, issues, and pull requests. Provision the review workspace Durable Object and its separate container application, cluster persistence, and the scheduled outbox and retention processing.

For each connected public repository, an active Janitor teammate signs in through Access and opens repository Settings. Enable issue review and leave dry-run on for the initial check. Settings use Janitor membership; they do not require a separate human repository-admin check. Deployment availability alone never enables a repository. Repository connection, pause, GitHub access, and review enablement still govern work. Cache readiness, failure, and the synchronization switch do not.

Repository opt-in delegates downstream CI safety to repository administrators. Janitor does not audit CI or promise fork-equivalent restrictions for its same-repository branches. Repository scripts run with outbound internet in the review sandbox. GitHub, Slack, and model credentials remain in trusted orchestration, outside that sandbox.

## Invocation and results

A human with current effective GitHub write or admin permission posts a new comment on an open issue, for example:

```text
/janitor Please investigate why retries never stop and try a minimal reproduction.
```

The command can appear anywhere outside quotes, code, or link destinations. Issue bodies, edited comments, PR comments, bots, and ordinary replies do not invoke review. The former `@janitor` syntax no longer invokes review. Permission lookup failures deny work. Review stores the accepted instructions unchanged. Editing or deleting that invocation stops its run; post a new comment to supply replacement instructions.

The agent searches related issues and PRs in the same repository, inspects the recorded default-branch commit, and investigates with a 15-minute deadline that includes installation and testing. One run is active per issue; later invocations queue in order. Different issues can run concurrently. A runner restart may resume persisted actions if the workspace remains usable, without repeating completed model calls. Workspace loss interrupts unfinished investigation and requires a new invocation. Neither recovery path resets the deadline.

Open the repository's Reviews page for instructions, invoker, tested commit, findings, evidence, proposed tests, and publication outcomes. The model records its reproduction assessment for human review. For the MVP, application code does not approve that interpretation by matching quotations, recognizing assertion text, comparing test exit codes, or requiring current-patch evidence. Commands, output, commit and patch identities, and execution limitations remain available beside the assessment. The model is instructed to treat setup failures as inconclusive and passing tests as insufficient to prove the bug absent. Draft publication still requires an intact failed execution of the current permitted test patch, publication authorization, and validated GitHub output. Reproduction patches may contain tests and necessary test-only helpers or fixtures in the discovered layout. Production fixes, workflows, manifests, lockfiles, and build configuration are prohibited.

## Dry-run and explicit publication

Dry-run saves findings and proposed patches without automatic GitHub writes. Turning dry-run off does not publish previous results. Turning it on blocks further automatic writes while investigation may finish.

To publish a saved result, link your GitHub account from Account, open Reviews, and select Publish results. Your current GitHub permission must be write or admin. You may publish even if the original invoker has lost permission; history records both identities. This authorizes only the selected result, and repository dry-run can stay on.

Only the latest invocation's completed result is eligible, within 14 days of acceptance, with no newer active or queued invocation. The source comment must still exist unchanged. Cancelled results, closed issues, paused or disconnected repositories, unavailable GitHub access, and disabled review cannot publish. The server repeats these checks even if the browser still displays an earlier eligible result.

Publication uses saved validated prose, tests, and the tested commit. It does not call the model again, retest, or silently rebase onto a newer default branch. Repeated Publish results actions reconcile or return the existing attempt. History distinguishes pending, completed, blocked, partial, and unresolved publication.

The agent authors GitHub prose; trusted code validates its links, mentions, length, and patch scope. GitHub output contains no Janitor frontend references. A reproduction PR stays draft. Later runs reuse it only while its branch and PR text match Janitor's recorded publication. Human edits or marking it ready block reuse. Closed or merged PRs remain untouched; a new invocation may create a new draft.

## Cancellation and uncertain writes

Cancel run on Reviews requires a linked GitHub identity with current write or admin permission. It stops the selected active or queued run while other queued requests remain independent. Closing the issue, pausing or disconnecting the repository, losing GitHub access, or disabling review stops applicable active work and cancels its queue. Restoring eligibility never revives those runs.

Cancellation can be processed while an action is pending. It stops sandbox work when detected but cannot recall a write GitHub already accepted. Local controls serialize with publication where possible. Remote permission checks and writes cannot be atomic: permission revocation, issue edits, or human changes may race with a write after its last check.

Lost responses trigger reconciliation using persisted intent and publication ownership before another write. Completed writes remain visible after cancellation. A partial attempt can leave an orphan branch; Janitor does not delete it as rollback. An unresolved outcome blocks further writes. Inspect the saved outcome and actual GitHub artifacts before taking manual action. Do not assume retrying will clear a human-edit conflict or an outcome that cannot be established. Publication retries never authorize fresh model work.

## Retention

Detailed history expires 14 days after invocation acceptance, including instructions, model/action data, evidence, patches, and reports. The retention sweep also queues workspace destruction, retrying failed cleanup. Expired results cannot be explicitly published even before the next sweep removes them.

While the repository remains connected, minimal invocation receipts prevent webhook replay, and summary identity plus branch/PR ownership fingerprints allow later runs to recognize publications and human edits. These records do not retain full old reports. Disconnection removes management records and fences delayed work; published GitHub comments and PRs remain.

## Sandbox resources and slow reviews

Review sandboxes use a custom Cloudflare allocation: 2 vCPUs,
6 GiB memory, and 8 GB disk. Cloudflare requires at least 3 GiB per vCPU,
so a 2-vCPU container cannot use only 4 GiB. This is separate from the Slack sandbox application.
The implicit `lite` default provides only 1/16 vCPU and 256 MiB memory and is too
small for Janitor's dependency installation. See [Cloudflare instance types](https://developers.cloudflare.com/containers/platform/limits/).

Setup commands are capped at three minutes and test commands at two minutes,
always within the original 15-minute review deadline. The workspace RPC gets up
to 15 additional seconds for process cleanup and evidence collection, also within
the deadline. Command timeouts remain inconclusive evidence; the model can inspect
the failure and conclude instead of waiting out the whole review. The sandbox
retains bounded stdout/stderr in timeout errors. Avoid piping commands to `tail`,
which hides their output until the pipe closes.

Each model call receives the remaining time. With two minutes left, only
assessment of saved attempts and conclusion are offered; with one minute left,
only conclusion is offered. Tool handlers also reject late investigation calls,
and command timeouts leave room for cleanup before that reserve. The original
deadline still applies, including to provider requests that fail or stall.

Production logs include `Review command started` and `Review command finished`
with run, sequence, attempt, kind, time limit, elapsed time, and exit status.
They omit command text and output. A `Review model call failed` timeout may include
time executing tools; correlate it with workspace RPC and command timings before
attributing it to the model provider.

On September 18, 2026, issue #81's run
`62cde073-11c6-41ba-8217-92969e377499` completed 15 rounds, then spent about
625 seconds in `execute` installing dependencies. It also encountered 52 transient
provider failures earlier, accounting for roughly one minute. A clean container
comparison at the recorded commit `a51348d125ce`, with Node 24.21.0 and pnpm
11.20.0, reproduced an OOM kill on the production-sized allocation. The same
install succeeded in 67 seconds with `standard-1` CPU/memory limits. This identifies
undersizing as a reproduced failure mode; the production timeout did not retain
enough install output to establish the exact package or process where it stalled.
The minimal issue #81 fixture then ran in 0.53 seconds in the larger container,
with three failures for the reported indented-fence bug and two passing controls.
The fixture was run against the recorded commit, outside the working checkout;
this infrastructure change does not fix the parser bug under review.

A later issue #81 run, `a3236260-01c6-4a14-a0c4-9d2af49da501`,
used the corrected 2-vCPU, 6-GiB allocation. Its ten commands took 72 seconds
combined, including a successful 44-second setup. It completed 31 model rounds
and timed out on round 32; two model calls retried after tool-parameter validation
errors. Most elapsed time was therefore outside command execution. The agent
previously offered all investigation tools until the deadline and supplied no
updated time budget. The conclusion reserve addresses that scheduling defect;
command outputs are still needed to explain the repeated test attempts.

The assessment approval checks were removed for the MVP after the saved record of
run `a3236260-01c6-4a14-a0c4-9d2af49da501` showed seven rejected assessments
after a successful reproduction. Exact quotation checks, suite-level exit codes,
and replacement-patch requirements drove extra model calls and test executions.
`assessReproduction` now saves the model interpretation without an evidence
approval loop. Basic input shape and size limits still apply.
