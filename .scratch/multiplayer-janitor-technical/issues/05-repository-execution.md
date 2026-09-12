# Decide repository access and workspace isolation

Type: grilling
Labels: wayfinder:grilling
Status: resolved
Parent: ../map.md
Blocked by: 03, 04

## Question

How does a session select, access, and edit one connected repository while preserving work by humans and other sessions?

Define repository selection for ideas without a PR, execution workspace lifetime and isolation, branch selection, GitHub App credentials and required permissions, and the publish contract for existing versus new PRs. Cover concurrent human commits and independent sessions targeting the same repository or PR. Respect existing repository pause, disconnection, and access-loss semantics, identifying any genuine product conflict for a user decision. Specify how tests and shell tools execute under the chosen runtime without assuming Durable Objects provide a git working tree.

Select the external execution service and its OpenCode integration approach under the accepted separate-runner architecture. Define the contract and acceptance cases for [Verify the remote repository execution contract](12-remote-execution-verification.md), including any further provider research needed to choose that service.

## Comments

### First discussion round, awaiting answers

Carry forward the accepted product behavior: one repository per session; update an existing PR's branch when revising it; create a separate proposal only when requested; create a PR for new work when appropriate; humans merge. Preserve concurrent human edits and ask on the PR when meaning conflicts. These are not being reopened.

Proposed decisions:

1. Give every session its own working copy and preserve its edits, including uncommitted work, between turns. Compute may stop or move, but loss of a process must not silently reset the workspace. This is a required behavior to test against the selected external execution service, not a claim that a provider already supports it.
2. Permit one actively associated Janitor session per PR in the MVP. A request from another thread targeting that same PR should direct the teammate to the existing session's home thread rather than create an independent writer or a second home thread. Existing human collaborators can still push commits; their changes must be incorporated. Access handling follows the identity/platform contracts.
3. Infer the connected repository from an explicit repository, issue, or PR reference. When the intended repository is ambiguous, ask in the originating thread before creating its execution workspace or changing files. Do not introduce required channel-to-repository setup or silently select a repository from a vague request.

Read-only investigation is checking pinned OpenCode remote workspace/environment APIs, Cloudflare Sandbox's current documented capabilities, and Janitor's existing GitHub App credentials/permissions. Execution-service choice and its credential implications await those facts.

### Accepted workspace and routing behavior

The user accepted all three suggestions: a separate working copy per session with uncommitted edits preserved across turns/restarts; one associated Janitor session per PR in the MVP, directing another thread to the existing home thread; and asking in the originating thread when the connected repository cannot be determined unambiguously from the request. The execution-service implementation must satisfy these requirements rather than silently weakening them.

### Execution-service and access facts

Read-only inspection at OpenCode revision `2df00955cb933e977427535d2505e50cbc689c69` found a Workerd `workspaceProviders` extension point, but no Cloudflare Sandbox adapter. `packages/core/src/workspace/driver.ts:27` requires idempotent creation by workspace ID, connect, idle suspension, and destroy. `environment/driver.ts:4` requires a ChildProcessSpawner; the default file implementation requires GNU coreutils/findutils in `environment/exec-defaults.ts:8`. A real process/filesystem adapter remains implementation and verification work.

Current official Cloudflare sources distinguish ephemeral sandbox files from saved directory backups. Idle shutdown/restart loses the live filesystem; keepAlive does not make storage durable. R2 backups are immutable snapshots requiring restoration; production restore and local restore differ. See [sandbox lifecycle](https://developers.cloudflare.com/sandbox/concepts/sandboxes/) and [directory backups](https://developers.cloudflare.com/sandbox/concepts/backup-restore/). The [1.0 preview](https://developers.cloudflare.com/sandbox/1-0-preview/) also differs from stable and requires an explicit matching SDK/image selection. No release or service has been selected yet.

Janitor's existing `apps/cluster/src/GitHub/AppAuth.ts:202` caches tokens by installation alone, and the token request at `:217` does not restrict repository IDs or permissions. `packages/domain/src/GitHub/Installation.ts:77` does not require contents access or PR write. [GitHub installation tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app) can be restricted to selected repositories and permissions. Repository scope alone does not restrict which branch can be written.

### Next discussion round, awaiting answers

Before choosing an execution service, clarify what preserving the workspace means when a machine disappears mid-operation. Proposed minimum: durably save workspace changes before reporting a modifying operation as complete; restore that saved state after loss of the live machine. Interrupted work since the last save may need to be reconstructed. Reconcile external effects before retries, as already accepted. Do not silently weaken preservation of completed, uncommitted edits to a fresh checkout or best-effort idle snapshot. Provider and adapter feasibility remain unverified.

Separately, propose giving the execution environment read access only to its session's repository, keeping GitHub App credentials in Janitor, and exposing authenticated, session-scoped publication operations for pushes and PR updates. Janitor checks current repository access and the session's target branch before publication. This preserves automatic agent publication without giving arbitrary repository commands general GitHub write credentials. The design must accommodate the chosen execution service and explicitly verify authentication and publication behavior.

### Cloudflare Artifacts candidate

The user proposed Cloudflare Artifacts for repository storage, clarified the product name, and said they may be able to obtain early access through its lead developer. This is a candidate proposal, not confirmation of access or acceptance of the pending checkpoint/publication questions.

Current primary documentation describes [Artifacts](https://developers.cloudflare.com/artifacts/) as closed-beta versioned file-tree storage with Workers, REST, and Git interfaces. [Repository isolation](https://developers.cloudflare.com/artifacts/concepts/repositories/) supports a repository per session. The [Sandbox SDK example](https://developers.cloudflare.com/artifacts/examples/sandbox-sdk-artifacts/) pairs sandbox and Artifacts identities and supplies scoped Git access. This is evidence for storage/compute integration, not a ready OpenCode adapter or automatic persistence of local writes.

Recommend investigating one Artifacts repository per Janitor session as durable versioned workspace storage, with a sandbox providing processes and tests. GitHub remains the upstream and human PR review/merge location; the runner DO still owns the conversation. This preserves the accepted hosting/state boundaries. The precise checkpoint representation and publication path are still undecided.

[ArtifactFS](https://developers.cloudflare.com/artifacts/guides/artifact-fs/) provides a FUSE-mounted working tree with lazy hydration. Its docs recommend ordinary Git clones for smaller repositories. They do not establish that every uncommitted local write is automatically durable remotely. Verify persistence acknowledgment, crash recovery of tracked/untracked/staged changes, and separation of internal workspace checkpoints from published PR history before claiming the preservation requirement is met. Also assess dependency/build cache handling and [repository size limits](https://developers.cloudflare.com/artifacts/platform/limits/).

Early-access discussion should establish account availability, supported SDK/image/API versions, write/checkpoint semantics, and any beta limitations affecting restore. No contact, access request, deployment, or paid experiment has been performed or authorized here. The existing remote-execution verification ticket remains the gate for a concrete Artifacts-backed candidate if selected.

### Recommended filesystem persistence strategy, awaiting acceptance

For the first durability implementation, recommend explicit workspace-directory checkpoints using the Sandbox SDK's R2 backup/restore facility. Artifacts remains a strong candidate for versioned repository storage, but its Git integration alone does not demonstrate faithful recovery of the working tree, index, untracked files, and local Git state. Do not require two competing authoritative checkpoint stores in the MVP.

The proposed checkpoint contains the working tree, `.git`, and required non-reproducible workspace files. Exclude known rebuildable dependency/build caches and injected credentials explicitly; do not assume every gitignored file is disposable. Runtime/image configuration should recreate tools and dependencies rather than snapshot the entire operating system or live processes.

Serialize modifying operations and quiesce workspace writers while capturing a checkpoint. Save after each completed modifying operation, including a failed command that left edits, before acknowledging that operation's filesystem effects as durable to the runner. Shell operations may modify files even when their intent appears read-only. A checkpoint failure must not silently advance the durable progress record. Test overhead before accepting this granularity; weakening it requires an explicit change to the recovery guarantee.

After a backup succeeds, durably record its handle and the corresponding operation/checkpoint identity in runner-owned state, then acknowledge completion. Keep the previous valid checkpoint until the replacement is recorded. Restore only a fully recorded checkpoint after sandbox loss and reconcile interrupted external effects before retrying. A crash before recording a new checkpoint can leave an orphan backup and an uncertain operation; it is not evidence that the operation never ran.

The [backup guide](https://developers.cloudflare.com/sandbox/guides/backup-restore/) documents serializable handles, exclusions, and TTLs. Its default three-day TTL is unsuitable as an implicit lifetime for ongoing sessions; retention must keep every referenced checkpoint restorable. The [directory-backup semantics](https://developers.cloudflare.com/sandbox/concepts/backup-restore/) document immutable R2 archives, production overlay behavior, and differences from local restore. A production fixture must exercise repository status restoration, checkpoint failure/crash windows, and build/tool behavior after restore. No implementation or service choice has been accepted by this recommendation alone.

### Accepted R2 baseline and Artifacts fallback clarification

The user accepted the recommended R2 workspace checkpoint strategy and asked for the backup plan before, or in lieu of, obtaining Artifacts access. R2-backed workspace checkpoints are that plan and the MVP persistence baseline. Artifacts access is not a prerequisite for the MVP.

Use GitHub as the upstream repository and human PR review location, the sandbox as the live working environment, R2 for the saved workspace including local Git state and unfinished edits, and runner-owned Durable Object state for checkpoint references and recovery progress. An additional hosted Git remote is not required to preserve the workspace. Exact GitHub credentials and publication mechanics remain pending discussion.

Artifacts can be evaluated later against the same accepted recovery contract. Do not silently migrate storage, drop unfinished edits, or make two checkpoint stores authoritative. The R2 design still needs the existing remote-execution verification, including production restore, retention, operation/checkpoint crash windows, and measured checkpoint overhead. This acceptance does not claim that those checks have passed or authorize deployment/spending.

### Confirmed MVP direction without Artifacts

The user explicitly directed: "Let's build out the MVP without artifacts because I don't know how long it's going to take us to get access. So we'll keep it as a later option."

Proceed with Cloudflare Sandbox and R2 directory checkpoints as the selected MVP execution/storage direction. GitHub remains upstream and the PR review location. Artifacts integration and early-access provisioning are outside this MVP plan, not prerequisites or parallel implementation work. An eventual Artifacts option must be considered separately against the same workspace recovery guarantees.

Continue the implementation-ready planning effort on this basis. The exact Sandbox SDK/image release, OpenCode adapter, publication access boundary, repository lifecycle behavior, and required verification still need resolution; this direction does not establish tested durability or a completed spec.

### Repository lifecycle accepted; GitHub App clarification

The user accepted stopping new repository operations when paused or access is unavailable, retaining workspace checkpoints, and reporting the blocked reason. Work can continue after access/readiness return; a deliberately paused repository remains paused until a teammate resumes it. Disconnection/deletion semantics still need to be distinguished from pause.

The user asked whether read/write credentials could come through the GitHub App. Yes: the existing App is the proposed credential issuer for both. The unresolved distinction is how installation credentials reach Git operations, not whether to introduce another identity or credential system. GitHub supports repository- and permission-scoped installation access tokens. Existing Janitor token caching/request scoping and installation permission checks need extension for repository write and PR publication.

Clarification should compare ordinary sandbox Git authenticated through the App, potentially using an outbound credential-injection handler, with specialized Janitor publication tools. The previous publication-tool proposal was a recommendation, not an accepted requirement. Do not insist on a custom publication interface merely to reuse App credentials. Repository-scoped tokens do not alone constrain writes to the session's assigned branch.

### Accepted publication limitation and disconnection behavior

The user accepted preserving proposed changes in the workspace and explaining on the PR when Janitor cannot push to its branch. A teammate may request a separate PR or arrange access; Janitor does not create a competing PR automatically. The expected workflow is core contributors using branches in the main repository. Fork write limitations are an exceptional case.

The user also accepted extending repository disconnection to end its agent sessions and delete their saved workspaces and session data. The disconnect UI must explain that unpublished work will be lost. Published GitHub work remains, and reconnecting starts fresh. This differs from pause and temporary access loss, which retain work.

## Answer

Later scope refinement: the user accepted foreground-only shell commands in [Verify the remote repository execution contract](12-remote-execution-verification.md). Subprocesses may run within a command, but persistent background servers and watchers across commands are deferred. Checkpoint capture requires command descendants to have stopped.

Later implementation refinement: during [Verify the remote repository execution contract](12-remote-execution-verification.md), the user accepted a custom container process bridge and Janitor-owned R2 archives with explicit cleanup. These replace reliance on the SDK's expiring backup handles and limited process API, while preserving the accepted workspace recovery behavior. The historical SDK-helper recommendation below is not the final implementation requirement.

Use Cloudflare Sandbox for repository processes and files, with R2 workspace checkpoints and runner-owned Durable Object checkpoint references. Artifacts is deferred. The external environment integrates through the pinned OpenCode Workerd workspace-provider and process/filesystem interfaces; feasibility is still subject to [Verify the remote repository execution contract](12-remote-execution-verification.md).

- Each session works on one connected repository in a separate workspace. Infer it from an explicit repository, issue, or PR reference; ask in the originating thread when ambiguous. Preserve uncommitted work between turns and environment restarts.
- One Janitor session is associated with a PR. Another thread targeting it directs the teammate to the existing home thread. Independent work in the same repository uses separate workspaces.
- Existing PR work updates its branch. New work uses a separate branch and creates a PR when appropriate. Humans merge. Incorporate concurrent human commits and preserve their edits; ask on the PR when changes conflict in meaning. Never silently replace an existing PR with a competing proposal.
- Use Janitor's existing GitHub App for read/write authentication. Extend installation permission checks and token scoping/caching for repository access and PR publication. Ordinary Git with App authentication is the intended direction; credential injection and publication enforcement remain concrete verification decisions, not claims of an existing implementation.
- If publication to a PR branch is unavailable, preserve the proposed changes and explain on the PR. An authorized teammate can arrange access or request a separate proposal.
- Checkpoint the working tree, index, local Git state, and required non-reproducible files after modifying operations, including failed commands that leave changes. Quiesce writers for a consistent snapshot, exclude credentials and explicitly rebuildable caches, and durably record the new checkpoint reference before acknowledging its filesystem effects as durable. Retain the previous checkpoint until the replacement is recorded. Referenced checkpoints must remain restorable throughout the session's lifetime.
- Restore recorded checkpoints after environment loss. Reconcile uncertain external effects before retrying, following the accepted session recovery contract. A checkpoint is not evidence that an interrupted push or PR update did not happen.
- Pause or unavailable access stops new repository operations and retains work with a visible blocked reason. Access recovery requires repository readiness; deliberate pause requires teammate resumption. Disconnection ends sessions and deletes their workspace checkpoints and session data, with explicit notice of unpublished-work loss. Published GitHub work remains and reconnection starts fresh.

These decisions settle repository behavior and the execution/storage direction. The verification ticket must select and pin the SDK/image, implement and exercise the adapter in a disposable fixture, and settle credential delivery, publication reconciliation, checkpoint retention, and teardown mechanics before the final spec is implementation-ready. Failed feasibility assumptions return here for a decision rather than weakening the accepted behavior.
