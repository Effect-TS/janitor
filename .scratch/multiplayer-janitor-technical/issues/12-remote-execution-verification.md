# Verify the remote repository execution contract

Type: task
Labels: wayfinder:task
Status: resolved
Mode: HITL
Parent: ../map.md
Blocked by: 03, 04, 05

## Question

Verify that the selected external repository environment integrates with the pinned OpenCode Workerd runner through the agreed execution contract. Use a disposable fixture repository to exercise file reads/edits, a command and test, workspace persistence or restoration, and a reviewable Git result.

Check authentication between runner and execution service, scoped repository access, reconnect after interruption, and reconciliation when a remote operation completes but its response is lost. Follow the state and publication decisions rather than inventing a second retry or permission model. Do not mutate a team repository or publish to GitHub without authorization.

Prepare the fixture, resource needs, and exact acceptance checks before any required live access or spending request. Local mocks alone cannot establish compatibility with the chosen execution service. Preserve reproducible evidence and feed any failed assumption back into the hosting or repository decision before spec readiness.

The selected MVP candidate is Cloudflare Sandbox with R2 workspace checkpoints. Verify this arrangement without Artifacts: preserve the working tree and local Git state, record the checkpoint reference durably, destroy/recreate the execution environment, and restore equivalent unfinished work. Include snapshot consistency while commands can write, backup failure, checkpoint retention, restore overlay behavior, and checkpoint latency. Pin the Sandbox SDK and container image together. Artifacts access is not a blocker.

## Required concrete decisions and acceptance cases

- Select the SDK/image release and map OpenCode's workspace create/connect/idle/destroy and process/filesystem interfaces to it. Verify idempotent creation, process streaming, exit status, and the GNU utilities required by the default file implementation.
- Settle runner-to-sandbox authentication and GitHub App credential delivery. Evaluate ordinary Git with outbound credential injection, including expiry/refresh and absence of credentials from snapshots. Scope tokens and their cache keys to the intended repository and permissions. Distinguish repository-scoped authorization from branch restrictions; specify how publication observes the intended branch and current repository readiness.
- Exercise existing-PR branch updates, new-work branch creation, concurrent human pushes, unavailable branch write access, and a lost response after successful publication. Define the operation evidence used to reconcile retries without duplicate PRs or overwritten human work.
- Specify checkpoint retention and cleanup so an idle or paused session retains a restorable checkpoint without relying on an expiring default. Exercise tracked, staged, untracked, and required ignored files, with consistent snapshots and restoration of local Git state.
- Specify and test disconnection during active execution or checkpoint creation. Prevent stale events, retries, or reconnects from reviving ended sessions, publishing more work, or retaining newly created orphan checkpoints. Delete session data and saved workspaces while preserving already published GitHub work. Reconnection begins with new session identities.

Record the chosen mechanics and reproducible evidence in this ticket's answer. The repository decision settles required behavior, not these untested mechanics. Any choice that changes accepted behavior requires returning to that decision with the user before spec readiness.

## Comments

### Local baseline executed; integration remains unverified

Claimed and prepared a dependency-free [repository fixture](../prototype/repository-fixture/README.md). Host Git/archive checks passed for unfinished workspace state, concurrent human publication, and a simple remote-ref reconciliation. This did not exercise OpenCode's remote adapter, Cloudflare Sandbox, R2, or GitHub.

The [verification progress report](../research/repository-execution-verification.md) records the executed command and results, resource needs, and remote acceptance matrix. The [SDK source investigation](../research/sandbox-release-retention.md) investigates exact release/image pins and two blockers: expiring SDK backup handles and stable process stdin support. A complete deployment bundle must resolve these before any live experiment is proposed. The ticket remains claimed, not resolved.

The preview does not solve either gap. Proposed direction for discussion: retain Cloudflare Sandbox and R2, add a container process bridge that satisfies OpenCode's stdin/output/exit/cancellation contract, and own the archive manifest and cleanup policy instead of depending on expiring SDK backup handles. This adds adapter responsibilities and must be verified; no implementation or production guarantee follows from the proposal.

### Custom bridge and checkpoints accepted

The user accepted adding a container process bridge and managing checkpoint archives with explicit deletion instead of SDK backup expiration. This supersedes using the Sandbox SDK backup/restore helpers as the required implementation, while preserving Cloudflare Sandbox + R2 and the previously agreed workspace durability behavior. Proceed with a bounded fixture; the production integration and recovery contract remain unverified.

Local implementation progressed: HTTP bridge and checkpoint protocol fixtures pass, as do pinned OpenCode default file operations through a narrow local Effect adapter. The bridge also passes inside the pinned Sandbox container image. A Cloudflare smoke Worker and isolated resource configuration are prepared; Worker-only dry-run bundling and manual Podman image build pass separately. Wrangler's combined Docker build has a Podman flag incompatibility. Full evidence and limitations are recorded in the verification report. Account selection and live-resource authorization remain necessary before remote testing, and the full remote contract remains unverified.

### Disposable Cloudflare test authorized

The user explicitly authorized creating a disposable test and required cleanup. Do not ask for that authorization again. Account selection and authentication remain missing: `vp run cloudflare whoami` in the isolated remote fixture reported not authenticated, and no Cloudflare account ID or API credentials were present in the process environment. The user asked how to provide access. Prefer interactive Wrangler login in this environment and a nonsecret account name/ID rather than sharing credentials in chat. This authorization covers the isolated Cloudflare experiment, not GitHub publication or changes to production Janitor resources.

### Account authenticated; platform prerequisites missing

The user selected account `17f1cec1b09ffab00f11682104ee24dc` and completed Wrangler device authorization. Login and account membership checks succeeded. Isolated candidate resource names are `janitor-repo-probe-20260911-vwap`; no resources with those names were created.

Pushing the locally built fixture image failed with Unauthorized. A follow-up read-only container listing returned: "You do not have access to Cloudflare Containers. Deploying containers requires the Workers Paid plan." R2 bucket listing returned code 10042: "Please enable R2 through the Cloudflare Dashboard." No image upload, Worker deployment, container creation, or bucket creation succeeded, so there are no disposable remote resources to clean up from this attempt. Account-level plan changes or billing activation were not performed.

Await enabling Workers Paid and R2 in the selected account, or selection of an already enabled account. Existing permission to run and clean up the disposable fixture remains valid; do not request it again once prerequisites are available.

### Authorized alternate account deployment in progress

The user instead selected `a5324318f7f0ddf25e7a1ba5359d1aa5` and completed a new Wrangler login. Containers access succeeded. Created dedicated R2 bucket and Worker `janitor-repo-probe-20260911-vwap`, uploaded only the fixture image to the same-named registry repository, and created container application `a038cfe2-5a7e-4e4f-b3b3-d8982807dcc8`, DO namespace `dfa6ec438427480b98b4dbfcf7984d1a`. Cleanup is mandatory after the test. Registry upload used a simple local image tag because the localhost-prefixed tag was interpreted as a registry destination and failed. Deployment uses the successfully pushed custom image, not the base image.

### Cloudflare smoke passed; cleanup verified

The single authorized remote request succeeded in 32,075 ms: process bridge checks passed inside Cloudflare Sandbox, a 61,440-byte custom archive was saved through R2, and a replacement sandbox restored identical staged, unstaged, and untracked Git state. [Result and scope](../research/repository-execution-verification.md) distinguish this from the full adapter/recovery contract.

Deleted the Worker, bucket, container application and registry image. Final container and image lists were empty; resource-specific API checks confirmed the Worker, DO namespace, and bucket no longer exist. Deleted the local fixture-token file. No remote fixture resources remain. Worker deletion alone did not remove the container application; cleanup explicitly deleted it.

The ticket remains claimed because complete OpenCode Workerd integration, durable operation/checkpoint crash windows, process-descendant containment, production-sized performance and GitHub App publication checks are not yet verified. The successful smoke test is evidence for the selected direction, not resolution of those remaining acceptance cases. GitHub mutation is not included in the Cloudflare-only test authorization.

### Continued local recovery and containment checks

Implemented and passed real lost-response tests for spawn/stdin, stale bridge-epoch rejection, and local SQLite operation/checkpoint persistence across child-process exits. Disconnection fences late completions. Rebuilt pinned OpenCode default file operations with the updated bridge and reran them successfully. Full details and test limits are in the verification report; these do not constitute full Workerd integration.

Per-command PID namespace containment passes in the local pinned container image, including a detached child attempting a delayed write. Its workflow consequence requires a user decision: background processes die when the command finishes. Recommend foreground-only shell execution for the MVP if acceptable, with persistent background servers requiring further supervision design. This is a new proposal, not an accepted restriction on OpenCode behavior. Keep namespace mode opt-in until decided and verified remotely. No additional live deployment occurred during this continuation, and the prior cleanup remains complete.

### Foreground-only commands accepted

The user explicitly accepted foreground-only commands for the MVP to simplify delivery. This is a deliberate restriction on normal OpenCode execution behavior: shell commands may spawn children while running, but descendants must not survive command completion or cancellation. Persistent development servers, watchers, and other background processes across commands are deferred.

Describe the restriction in the agent's execution environment and explain it clearly when relevant to a requested workflow. Do not claim that builds and tests cannot use subprocesses or parallel workers while the command remains active. Checkpointing must wait until the whole command's process tree has stopped, not merely its original parent.

Proceed with per-command namespace containment as the candidate implementation. Local evidence supports it; remote namespace availability, stdin/output and exit behavior under isolation, cancellation and bridge death, process-inspection compatibility, and Workerd integration remain verification requirements. Fail visibly if containment cannot be established; do not silently fall back to process-group killing. This acceptance does not resolve the verification ticket or establish those unexecuted checks.

### Workerd files passed; containment deployment in progress

The pinned OpenCode default file implementation passed binary write/read, stat, move/list/remove through a narrow Effect spawner in local Workerd, with a service binding forwarding to the external HTTP bridge. This closes the earlier Node-only limitation for those file operations; it does not establish the entire session/provider lifecycle or complete spawner interface. Bundling required the same node:module createRequire compatibility banner used by the earlier Workerd probe because an indirectly loaded package imports child_process; actual repository processes remain outside Workerd.

Under the existing disposable-test authorization, redeployed the fixture in account `a5324318f7f0ddf25e7a1ba5359d1aa5` to verify foreground containment. Worker/bucket name remains `janitor-repo-probe-20260911-vwap`; new container application `a0382936-c5e0-476a-a37d-a47d82887657`, DO namespace `f86e21c3bf96423894de04c9c330d799`, image tag `containment`. These new resources must be removed after the test.

### Remote containment passed; cleanup complete; native shell gap identified

The authorized Cloudflare containment run passed in 19,905 ms, including detached-child termination, cancellation before freeze, bridge checks and R2 restoration. [Evidence and remaining shell gate](../research/repository-execution-verification.md#workerd-files-and-remote-foreground-containment-verified) records scope and reproducibility. Deleted all new resources, verified empty container/image lists and resource-specific 404 responses, and removed the temporary fixture-token file.

Pinned native shell source captures output using its local Node filesystem and supplies cwd options unsupported by the narrow file-test spawner. Its tool also exposes background execution and job promotion. Verify native shell output capture and foreground-only enforcement in Workerd next; neither the file probe nor process containment proves this integration. Preserve native behavior where possible; any replacement tool or output-retention tradeoff needs an explicit decision. The ticket remains claimed.

### Native shell service passed; capture-path adapter required

The pinned native Shell service now passes in local Workerd with the external host bridge: combined output, nonzero exit, timeout, and removal followed by workspace freeze. A 100,000-byte output demonstrated that the native truncated-output notice refers to a Workerd-only file the repository adapter cannot read. Copying the settled capture into the external workspace preserved every byte. [Evidence, limitations and recommended adapter](../research/repository-execution-verification.md#native-shell-service-verified-in-local-workerd) records the details.

Foreground promotion is explicit in the inspected tool/session APIs, not automatic on queued messages. Enforce the accepted restriction by rejecting background tool requests before execution and excluding background/session-shell entry points from Janitor's runner contract, in addition to process containment. Full native tool/runner enforcement is not yet tested. Preserve the native Shell service; candidate integration copies completed captures into checkpointed session workspace storage and returns those paths before durable completion. That protocol still needs fault and recovery checks. No new remote resources were created. Keep this ticket claimed.

## Answer

Verified the remote repository execution contract for the foreground-only MVP. The [final acceptance results](../research/repository-execution-results.md) record the executed SDK, Cloudflare, fault, GitHub and cleanup checks, with their limits. The integration uses the pinned OpenCode Workerd SDK, Sandbox 0.12.9 and its pinned image, Janitor-owned R2 archives, and GitHub App installation credentials. Artifacts is not required.

### Mechanics for the implementation spec

1. Keep the separate runner Worker and one DO per session. Use the real OpenCode workspace provider and Environment spawner interfaces. Derive the provider resource identity deterministically from the logical workspace ID so repeated creation adopts the same resource, including before a binding was saved. Connect to that resource and validate its bridge protocol/epoch. Physical suspension retains the committed checkpoint; reconnect restores into a clean workspace. Destruction fences the identity before deleting execution resources.
2. Use underscore-prefixed runner tables such as `_janitor_*`. OpenCode owns unprefixed tables and explicitly ignores embedder tables with an underscore prefix during bootstrap. This is the supported shared-SQLite convention; a mandatory SDK-first initialization order is not required when it is followed.
3. Carry private runner-to-Sandbox traffic over the namespace/service binding and authenticate the process bridge. Bind operations to the session generation and bridge epoch. Preserve immutable operation IDs and payloads, sequence stdin chunks and EOF, and read output by cursor. Same-epoch retries may recover an existing operation. A changed epoch never authorizes blindly replaying an uncertain operation.
4. Support the standard process operations required by native OpenCode file and shell tools, including cwd within the workspace, argv, environment, binary stdin, output streams, exit status, timeout and cancellation. Use the pinned GNU utilities in the image. Keep per-command process-tree containment; do not fall back silently if it is unavailable. Additional Effect file descriptors and command-pipeline objects are outside the exercised adapter surface, while normal shell pipelines and child processes work.
5. Keep the native shell tool and native job/conversation behavior. Reject background requests before tool execution and describe foreground-only behavior to the agent. Do not expose the session-background or direct session-shell entry points through Janitor. Ordinary queued messages do not require invoking those APIs.
6. Persist operation admission before dispatch. Once writers have stopped, copy native shell captures from Workerd's temporary filesystem into session-owned workspace storage, excluding them from published Git changes. Rewrite full-output notices to the readable workspace path. Upload the consistent archive and commit its reference and operation result before returning the native tool result. Failed commands that left edits follow the same checkpoint path. The integrated SDK fixture exercised this ordering.
7. Keep archives and their format/hash metadata under a session/workspace prefix, without SDK expiry metadata. Retain the previous pointer until the new pointer and result commit atomically. Reconcile uncommitted uploads and prune unreferenced objects. Restore only a verified archive into a clean destination, preserving the working tree, index, local commits and required ignored files. Do not mistake a successful upload for a committed checkpoint.
8. Use the existing GitHub App credential authority. Mint tokens scoped to the numeric repository ID and the required permissions; key any cache by installation, repository and permission set. Refresh before the returned expiry and reconcile authorization failures rather than broadening permissions. Keep the App private key outside the runner's repository environment. Deliver only short-lived scoped credentials to controlled Git invocations, without credential-bearing URLs, persistent Git configuration or inclusion in snapshots. The Sandbox integration verified temporary command environment delivery.
9. Recheck repository connection/readiness, session generation, intended repository and branch before publication. App token scoping does not enforce a branch boundary. Update the associated PR branch, or create the designated new-work branch/PR. Never force over human commits. Reconcile a stale push against fetched history; escalate meaning conflicts as already agreed. Record the intended commit and PR head/base identity before sending writes. Inspect remote refs and existing PRs after lost results before retrying. GitHub's PR representation can lag the Git ref, so retry those reads rather than repeating successful writes.
10. On disconnection, fence new work and late completions first, terminate active execution, remove the native SDK session, and delete saved workspace data and pending/orphan checkpoints. Retain only the control-plane tombstone/cleanup information needed to reject stale work until cleanup finishes. Reconnection allocates new identities. Already published GitHub work is independent of this cleanup.

### Verification outcome and scope

The final Cloudflare fixture passed an actual SDK session with a deterministic model, native shell execution and foreground rejection, durable admission and checkpoint-before-result ordering, binary process transport, real lost network replies, complete workspace restoration, DO abort recovery on both sides of pointer commit, and disconnection while a command was running. Native session deletion was verified against the pinned SDK's `session_v2` table.

The authorized private GitHub fixture passed scoped credentials, refresh/revocation, ordinary Git publication, existing-PR updates, concurrent pushes, denied writes, lost-result reconciliation and credential exclusion from archives. A separate Sandbox-to-GitHub clone/push passed. The supplemental protected-branch configuration was unavailable under that private repository's plan; no protected-branch-specific pass is claimed. The required unavailable-write case passed with a read-only token.

All disposable Cloudflare resources and registry images were deleted and absence verified. All temporary GitHub branches were deleted, test tokens revoked, and PRs 6 and 7 closed without merging. The default branch was unchanged. The local fixture secret was removed; the user's existing App credentials and authentication were retained.

This closes execution-service feasibility and the concrete repository contract. It does not claim that the prototype is a production adapter or that unattended runner supervision has been verified. The latter already belongs to [Choose durable runner supervision and wakeup](13-runner-supervision.md) and [Verify unattended progress and recovery of the session runner](11-runner-lifecycle-verification.md).
