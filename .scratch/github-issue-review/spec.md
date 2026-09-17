# GitHub-invoked issue review

Design confirmed by the user, including the requirements below and the mechanics in [backend-design.md](backend-design.md). The design interview is complete. Implementation remains out of scope and is not authorized by this confirmation.

## Settled architectural decisions

- [Synchronization is only a UI cache](../../docs/adr/0006-synchronization-is-a-ui-cache.md), with the existing automation migration required before production issue review.
- [Explicit GitHub invocation](../../docs/adr/0007-explicit-github-invocation.md), including authorization, instruction boundaries, queuing, cancellation, and repository controls.
- [No reviewed CI contract for the MVP](../../docs/adr/0008-defer-reviewed-ci-contracts.md). Administrators own downstream CI safety and invokers own their instructions.
- [Sandbox internet access for the MVP](../../docs/adr/0009-allow-sandbox-internet-for-the-mvp.md), while credentials and publication authority remain outside the sandbox.
- [A persistent agent Entity with embedded action workflows](../../docs/adr/0012-model-the-agent-as-a-cluster-entity.md), including LLM calls and publication, with Activity idempotency and reconciliation of uncertain outcomes.
- [Explicit publication of dry-run results](../../docs/adr/0011-explicit-publication-of-dry-run-results.md) by a currently authorized frontend user.

## Accepted review behavior

- Repositories opt in individually, with enable/disable and dry-run controls.
- Review settings use existing frontend authorization: an active Janitor member authenticated through Cloudflare Access, with repository availability and application capabilities determined by GitHub App access. Do not add a separate human repository-admin check for settings. Invocation, cancellation, and explicit publication retain their agreed effective GitHub write/admin checks.
- Classify issues as bug, enhancement, question, or unclear. If unclear, explain missing information and stop until a new authorized invocation.
- Search open and closed issues and PRs in the same repository for likely duplicates, link matches, and continue relevance checks.
- Investigate against a recorded commit from the actual default branch. Check whether a reported bug exists, is already fixed, or a requested feature already exists.
- Confirm reproduction only when a minimal test executes and fails for the reported behavior. Setup, dependency, and fixture failures do not qualify.
- A reproduced bug produces a linked draft reproduction PR with the failing test and no fix, unless a strongly related existing issue makes it redundant under the evidence rules below.
- Explain unsuccessful reproduction attempts, distinguishing not reproduced from inconclusive. Neither establishes absence of the bug.
- Answer questions from code or documentation with evidence and uncertainty as appropriate. Search related issues and PRs but do not create a reproduction PR for a question.
- Maintain one summary comment per issue across authorized runs. Slack integration and notifications are out of scope for the MVP, replacing the original notification requirement.
- Issue review does not apply labels or feed findings into labeling for the MVP. Existing labeling retains ownership and operates independently.
- Dry-run presents findings and proposed test changes in the frontend without GitHub writes or Slack notifications.

## Accepted evidence rules

Suppress a new reproduction PR only when evidence supports the same behavior under materially equivalent conditions and an existing issue already tracks that unresolved problem or links an adequate reproduction. Link the issue and explain why another PR adds no useful evidence. Similar wording is insufficient. A closed issue alone does not justify suppression; behavior that still reproduces may be a regression or an incomplete fix.

Reserve confirmed fixed for a relevant test that fails on an affected revision and passes on the recorded default-branch commit. Convincing code or PR evidence without an executable comparison supports appears fixed, with an explanation of what was not verified. A closed issue or an unrelated passing test is insufficient. Historical testing is optional; Janitor may report the weaker conclusion.

Enhancement reviews explain existing support, remaining gaps, and related issues or PRs with evidence. They do not produce an implementation branch or PR. If the request is too ambiguous to assess, ask for the missing information and stop until another authorized invocation.

## Accepted execution requirements

The MVP targets open-source repositories. Use a sandbox image containing Node.js, pnpm, and commonly needed system dependencies so the agent can install public packages and execute tests. Do not introduce a dedicated dependency service for the MVP. Exact image contents and versions remain to be selected.

Repository scripts and issue-provided commands execute only inside the sandbox. GitHub, Slack, and model credentials remain outside it; trusted orchestration performs authenticated GitHub operations and publication. This workflow has no Slack integration in the MVP. Outbound internet access is allowed for package installation and tests, replacing the original restricted-egress requirement.

Each run has a 15-minute execution timeout, including installation and testing. There is no model-call limit or additional feature-specific spending or API quota for the MVP. Respect provider rate limits and retry transient investigation failures only within the remaining execution time. Timeout reports attempted work and limitations without claiming the bug is absent. Publication recovery remains separate and never restarts investigation.

Use the deployment's existing agent-model configuration, independently of the labeling model, with no per-repository model selector for the MVP.

Model each review run's agent as a persistent cluster Entity with messages in, messages out, and explicit persisted state. Use embedded Effect Workflows for actions, including LLM invocation. A separate per-issue scheduler coordinates independent runs and publications. Do not model the entire agent as one Workflow.

Different issues run concurrently in separate sandbox/agent sessions across the cluster, using available cluster capacity. The MVP has no feature-specific per-repository concurrency or queue cap. Same-issue serialization and the 15-minute execution timeout remain required.

A runner restart restores persisted agent state and resumes pending actions when the sandbox remains usable, reusing completed LLM results. Losing the sandbox's unfinished work interrupts the investigation: retain available findings and require a new invocation. Cancellation, current authority, and the original deadline still apply. Completed action results and uncertain publication writes remain recoverable; the MVP does not reconstruct a lost unfinished workspace automatically.

Closing an issue stops its active run, cancels queued invocations, and blocks publication of saved results while the issue remains closed. Reopening does not restart work or permit continuation of old work; a new invocation is required. Existing comments and PRs remain untouched.

## Accepted patch scope

Janitor discovers and follows the repository's existing test layout without manual path configuration. Reproduction patches may contain tests and necessary test-only fixtures or helpers in that layout. This replaces the earlier requirement for repository-configured allowed paths.

Published patches must not change production code, workflows, dependency manifests, lockfiles, or build configuration. Trusted application code validates paths and patch limits before publication; exact validation mechanics and limits are implementation details to specify before coding. If the patch cannot satisfy the constraints, report the blocker.

If reproduction requires a prohibited change, explain the blocker and retain findings in the frontend. Allowed paths do not establish that code is safe. A reproduction PR must remain draft and contain no bug fix.

## Accepted publication behavior

Reuse an existing reproduction PR only while it is an open draft and its branch and PR content match Janitor's last recorded publication. Do not overwrite human changes. If a human edits it or marks it ready, leave it alone and retain proposed changes in the frontend. Never automatically reopen a closed or merged PR; a new invocation may produce a new draft when current evidence warrants one.

Publication uses the recorded investigation commit even if the default branch advances during the run. State that commit in findings and the PR. Do not silently rebase an untested patch or claim it was tested against a newer commit. A later authorized run can reassess current code.

Retain validated patches, test evidence, and publication intent before the first write. Effect Workflow Activities reconcile interrupted writes before retrying and enforce fresh authorization and repository checks. Publication recovery does not restart model work; an outcome that cannot be established blocks further writes and is reported as unresolved.

## Accepted frontend history and retention

Provide per-issue run history showing invoker, instructions, tested commit, status, findings, test evidence, proposed patch, and publication links. Retain detailed run data for 14 days. GitHub carries most contributor-facing context.

Keep minimal invocation-deduplication and publication-ownership records beyond that window while the repository remains connected. Expiration of detailed history must not enable webhook replay to start work again or discard ownership of Janitor's PRs.

The frontend offers Publish results to any user with current effective write or admin permission on the repository. Their action supplies fresh publication authority even if the original invoker has lost access; retain both identities. Use saved, validated findings and patches without repeating model work, with fresh repository and publication checks and the same per-issue serialization as other writes.

Explicit publication of one selected result is allowed while dry-run remains enabled. Pause, disconnection, unavailable access, and disabled issue review still block it. Merely disabling dry-run never automatically publishes previous results.

Only the latest invocation's completed result may be published, within its 14-day retention window, with no newer active or queued invocation. Its source invocation must still exist unchanged and the run must not have been cancelled. Older results remain viewable but cannot be published through this action. Repeated clicks reconcile or return the existing publication rather than creating another one.

## Published text

The agent writes the GitHub reply and PR description. Do not use application-owned prose templates for the MVP. Published GitHub output must not reference Janitor's frontend. The proposed templates and frontend links in Q40 were rejected.

Trusted application code prevents mentions and frontend links, checks that published links correspond to permitted evidence, and enforces output length limits. It does not rewrite replies into templates. Exact numeric limits are implementation details, not additional product settings. The earlier proposed 8,000/16,000-character limits and image/HTML restrictions were not explicitly accepted.

## Design confirmation

The user confirmed the consolidated design, including provisioning, Activities, durable records, validation, cancellation, and publication ordering in [backend-design.md](backend-design.md). Product decisions are recorded above and in the linked ADRs.

The user subsequently confirmed one agent Entity per review run, separate per-issue scheduling, and recovery after runner restart when the sandbox remains usable. The approved implementation breakdown is published in [tickets.md](tickets.md); creating the tickets does not start implementation.

Exact runtime/tool versions, schema names, retry intervals, and validation size constants remain implementation details. They must preserve these requirements and do not introduce new product settings or relax publication constraints.
