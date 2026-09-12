# Repository execution verification progress

Status: verification complete for this ticket. See the [final acceptance results](repository-execution-results.md) and [resolved contract](../issues/12-remote-execution-verification.md#answer).

The material below is the historical investigation. Earlier incomplete claims, provisional mechanics and pending cleanup notices are superseded by those final records.

Initial live-access check: user authorized the disposable test and completed Wrangler device login for account `17f1cec1b09ffab00f11682104ee24dc`. Cloudflare rejected container access because Workers Paid is required and R2 access because R2 must be enabled, code 10042. No disposable resources were created in that account. The user subsequently selected an enabled account as recorded below. No account billing settings were changed.

## Native shell service verified in local Workerd

The actual pinned OpenCode Shell service passed combined stdout/stderr capture, exit code 7, a 100 ms timeout, and removal of an active command followed by successful external workspace freeze. The file-operation regression checks also passed. See [raw result](native-shell-workerd-result.json) and [native service probe](../prototype/repository-fixture/native-shell.mjs).

This uses the pinned dependency graph and local Workerd with an external host process bridge. The native Shell implementation is unchanged. Event delivery, location, configuration, session environment and repository environment are fixture dependencies. The native ShellTool plugin, model loop, permission checks, durable runner recovery and Cloudflare execution are not exercised by this probe. Cancellation is checked through Shell.remove and eventual bridge freeze, not through the full agent/tool cancellation path. The spawner now forwards cwd; the fixture bridge only accepts its configured workspace directory and rejects all other cwd values. General workspace subdirectory support is still unimplemented.

The Workerd-conditioned global roots already place OpenCode's capture directory under /tmp/opencode. Native filesystem streams therefore work in the tested Workerd runtime. Earlier concern that local capture necessarily prevents shell execution is superseded by this executed evidence. The capture is still temporary and separate from the external workspace.

### Confirmed output-path gap and candidate adapter

A command producing 100,000 bytes caused the native result to truncate output and advertise its Workerd-local capture path. Reading that path through OpenCode's external default file implementation failed, as expected across separate filesystems. This is a confirmed integration gap, not just a potential durability issue.

The probe then read the settled capture in Workerd and wrote it through the real OpenCode file adapter into the external workspace. All 100,000 bytes matched. This establishes a bounded copying mechanism, not a durable completion protocol. It does not yet rewrite a native tool result or restore the copied capture from R2.

Recommend retaining the native Shell service, copying completed capture bytes into session-owned checkpointed workspace storage, and returning the workspace path in any full-output notice. Use a collision-safe session/operation path in production; the fixed fixture name is only for this test. Keep captures out of published Git changes while including them in workspace checkpoints. Capture copying and checkpoint commit must precede recording operation completion. Copy or checkpoint failure must remain visible and must not cause a completed command to be rerun. Recovery after command completion but before copying remains an uncertain-operation case to verify. Capture streaming/size bounds and the native capture-retention window also remain adapter requirements.

### Foreground enforcement points identified

At pinned revision 2df00955cb933e977427535d2505e50cbc689c69:

- packages/core/src/tool/plugin/shell.ts accepts background: true and calls Job.background. Its native execute.before hook can reject the input before execution, and a tool transform/context hook can describe foreground-only behavior without replacing command execution. These integration hooks have not been tested with the native tool in this probe.
- packages/core/src/session.ts exposes Session.background, which calls Job.backgroundAll. Do not expose or invoke this API through the Janitor runner contract. Ordinary queued prompts do not call this branch. Job.block races completion against explicit background promotion; the inspected code does not automatically promote a command merely because it runs for a long time.
- Session.shell and background-job restart paths also exist. The MVP runner must allow only its intended prompt/delivery operations and must not introduce background work through these alternate entry points. Verify the full configured runner and tool graph before claiming enforcement.
- Per-command process containment remains required even when background APIs are inaccessible, since a shell command can itself launch detached children. A freeze must observe the full process tree stopped before capture/checkpoint completion.

No new Cloudflare resources, GitHub mutations, model calls or credentials were used in this continuation. The verification ticket remains claimed. Next bounded check: native ShellTool execution through the configured runner with background rejection, copied-output path rewriting, and command/capture/checkpoint recovery ordering.

## Workerd files and remote foreground containment verified

The pinned OpenCode default file implementation passed binary write/read, stat, move/list/remove in local Workerd using the extracted fixture spawner and a service binding to an external host bridge. Reproduce in the pinned probe dependency graph with `vp run --no-cache files-workerd-bundle` and `vp run --no-cache files-workerd`. The fixture files are `fixture-spawner.mjs`, `worker-opencode.mjs`, `bundle-workerd-files.mjs`, and `probe-workerd-files.mjs`. This is actual Workerd execution of file operations, not a complete SDK session or Workerd-to-Cloudflare integration test.

The subsequent authorized Cloudflare test passed in 19,905 ms. Per-command PID namespace containment prevented a detached child from writing after its parent command finished, cancellation completed before freeze, the process bridge probe passed, and a replacement sandbox restored the small Git workspace from a 61,440-byte R2 archive. See [raw result](remote-containment-result.json). Total elapsed time includes startup and all checks; it is not standalone checkpoint latency.

Cleanup is complete. Container application and registry image lists were empty. [Resource-specific cleanup checks](remote-containment-cleanup.json) confirmed that the Worker, DO namespace, and bucket returned 404. The local fixture-token file was deleted. No GitHub mutation or model call occurred.

### Native shell integration remains a gate

Inspected pinned OpenCode revision `2df00955cb933e977427535d2505e50cbc689c69`, `packages/core/src/shell.ts`, especially service initialization and command creation. The service creates its output directory and uses Node filesystem streams to capture process output locally, even though process spawning goes through Environment. The narrow fixture spawner also rejects cwd options, which this service supplies. File-operation success therefore does not establish native shell compatibility.

`packages/core/src/tool/plugin/shell.ts` exposes a background input and a job path that can move work into the background. Foreground-only enforcement must cover both paths and wait for command-tree termination before checkpointing. Namespace containment alone does not change the tool's declared behavior.

Next, probe the actual native shell service and tool under Workerd with a cwd-capable external spawner. Check output capture, nonzero exit, cancellation, timeout, and the absence of background promotion. Prefer preserving the native service with a verified capture path and foreground restriction. If this requires replacing the tool or changing retained-output behavior, return that concrete tradeoff to the user before accepting it. No replacement tool has been selected or implemented here.

The full ticket remains claimed. Durable Object checkpoint/operation crash windows, provider lifecycle, representative archive performance, and authorized GitHub App publication remain acceptance requirements.

## Cloudflare smoke test passed and cleaned up

### Subsequent local recovery verification

Continued the claimed ticket after remote cleanup. No further remote resources were created in this round.

`vp run recovery` passed in `/tmp/janitor-recovery-run-xYUbPd`, producing fixture `/tmp/janitor-recovery-s6hbmU`. It deliberately destroyed HTTP responses after successful process spawn and stdin delivery. Same-ID retries observed the original outcome, and marker files showed one process start and one input write. Recreating the bridge with a new epoch made an old-epoch retry fail rather than re-execute.

A Node SQLite journal with FULL synchronization was exercised across separate child-process exits before an external effect, after the effect, and after committing completion with a checkpoint reference. The first two cases both remain uncertain, correctly demonstrating that receipt persistence is insufficient to infer whether an external operation happened. The committed completion and checkpoint pointer survived reopening together. Changed-payload retries were rejected. Disconnection invalidated the generation, cleared records, and rejected late completion/new admission.

These are real local socket and process-exit tests. They do not establish power-loss durability, Durable Object behavior, or exactly-once external effects. The test journal is not yet wired into a complete runner/provider implementation.

Rebuilt and reran pinned OpenCode default file operations with the updated bridge and task caching disabled; passed at `/tmp/janitor-opencode-files-LMoPVt`. An initial rerun exposed EPIPE from sending empty EOF to an already-finished no-input process. The bridge now treats this empty close as satisfied while preserving errors for nonempty writes. Duplicate stdin retries await the original write outcome. The adapter remains narrow, with full process options and Workerd integration outstanding.

The new namespace containment probe passed in the locally rebuilt pinned image `65adfdbc961587f0b54d4351bf810699fa81fdfe00748107adba704d697033b5`. A detached child signaled that it had started, but its delayed write never occurred after namespace init exited; forced cancellation also completed before freeze. [Containment findings](process-containment.md) record remaining remote and process-inspection compatibility questions. The user subsequently accepted foreground-only commands for the MVP. This mode terminates background processes at command exit, matching that accepted restriction. It remains an opt-in fixture mode pending remote verification.

### Earlier remote smoke evidence

The user selected account `a5324318f7f0ddf25e7a1ba5359d1aa5` and completed a fresh login. Ran exactly one authenticated fixture request on the disposable Worker. [Raw result](remote-repository-result.json): HTTP 200, elapsed 32,075 ms, custom archive 61,440 bytes, fixture `janitor-fixture-ac1e3810-5bab-49e0-8ced-3f70de282069`.

The bridge probe passed inside Cloudflare Sandbox. The Worker stored the generated Git workspace archive directly through its R2 binding, destroyed the original sandbox, and restored into a differently named sandbox. Staged diff, unstaged diff, and untracked Git status matched exactly. This used a Janitor-owned tar archive with no SDK expiry metadata; it did not use the SDK backup/overlay helper.

Deployment pins: Sandbox SDK/image 0.12.9, Wrangler 4.131.1, custom registry manifest `sha256:2442c956f54d50a9e0c5d702c1083eba75c7203b7692d54db6b4e2d97088b527`. Manual Podman build followed by Wrangler image push and deployment from the registry worked around the combined Docker-build flag incompatibility. Retagging the local image without the `localhost/` prefix avoided interpreting localhost as a remote registry destination.

The result explicitly leaves fullOpenCodeAdapterVerified, durablePointerTransactionVerified, and githubPublicationVerified false. The remote Worker exercises the process bridge and small-archive R2 round trip, not the complete runner/provider lifecycle. Host OpenCode file-operation evidence is separate. Total request time includes container startup and is not a measurement of checkpoint latency or representative repository performance.

Cleanup completed immediately after the test:

- Deleted Worker `janitor-repo-probe-20260911-vwap`, including its secret and DO namespace.
- Deleted the dedicated R2 bucket after fixture-level archive deletion succeeded.
- Explicitly deleted container application `a038cfe2-5a7e-4e4f-b3b3-d8982807dcc8`. Worker deletion alone left that application listed, so it was not sufficient cleanup.
- Deleted the custom image tag from the Cloudflare registry.
- Rechecked container applications and registry images: both lists empty.
- [API cleanup checks](remote-repository-cleanup.json) returned resource-specific 404s for the Worker, DO namespace `dfa6ec438427480b98b4dbfcf7984d1a`, and R2 bucket.
- Removed the local temporary fixture-token file. Source, dependency lock, and result artifacts remain for reproducibility; no secrets were copied into the repository.

No test resources remain in Cloudflare. Existing applications, repositories, or account billing settings were not modified. Cloudflare usage charges for the completed experiment are not measured by this report.

## Accepted bridge direction and additional executed checks

The user accepted a custom process bridge and Janitor-owned checkpoint archives with explicit deletion. This removes dependency on SDK backup TTL behavior; it does not remove the need to verify the archive, pointer, and operation recovery protocol.

Added and executed these probes:

- `vp run bridge`: authenticated local HTTP process protocol, binary stdin/EOF, separate stdout/stderr, exit code 7, cursor-based output retrieval, duplicate spawn and stdin requests, argv file writes, process cancellation, and freeze/thaw admission. Passed. Host fixture: `/tmp/janitor-bridge-W720f4`.
- `vp run checkpoint`: local in-memory object store, archive and manifest integrity, injected failure before pointer commit, restoration from the previous pointer, and rejection of corrupted bytes. Passed. Fixture: `/tmp/janitor-owned-checkpoint-zSgbXB`. This is not R2 or a durable pointer transaction.
- `vp run repository-bundle` then `vp run repository-files` in the existing isolated Workerd probe dependency graph: pinned OpenCode `execDefaults` called through a narrow Effect spawner over the HTTP bridge. Binary write/read, stat size, move, list and remove passed. Initial assertion compared Buffer versus Uint8Array object types despite identical bytes; changed it to compare bytes, then passed. Node execution only; not a Workerd run or complete spawner implementation.
- `vp run image` in `/tmp/janitor-remote-fixture-VWapHV`: Podman built the pinned SDK 0.12.9 image plus fixture bridge. Result image `df143772c737a1914de5047b970db5724831e6555b507ff2d8d368fcc413a96b`.
- `vp run image-test`: the bridge probe passed inside that image with external networking disabled. No Cloudflare compute was used.
- Installed the isolated remote fixture's 40 packages using `vp install`, with Sandbox 0.12.9 and Wrangler 4.131.1. Dependency lockfile retained with the fixture artifacts. Root application dependencies were not changed.
- Standard `vp run bundle` failed because Wrangler's Docker build command passes `--provenance=false`, unsupported by this environment's Podman wrapper. A separate Worker-only dry run using a generated config referencing the base registry image passed, producing a 622.74 KiB Worker bundle. This does not substitute the base image for the custom deployment image or establish a successful combined deployment. Manual image build and image test passed separately.

The bridge intentionally has in-memory process records and bounded output. Lost stdin-write responses, bridge restarts, arbitrary process options, detached descendants, and cancellation during checkpoint capture remain unverified. The prototype must not be presented as a finished production adapter. The archive fixture is limited to generated data; general archive extraction safety and large streamed R2 objects remain implementation work.

The reviewable Cloudflare smoke bundle is in the [fixture directory](../prototype/repository-fixture/README.md). It uses a dedicated Worker, Sandbox DO binding, up to two sequential sandbox instances, one dedicated R2 bucket, and a secret protecting its fixed test endpoint. It runs no model calls and uses no GitHub credentials. It tests custom archive persistence between two different sandboxes; it does not close all acceptance cases in this ticket. Cloudflare account selection and authorization for isolated live resources and their usage are still required. No remote deployment occurred.

## Executed evidence

Ran the dependency-free [repository fixture](../prototype/repository-fixture/README.md) through `vp run verify` in an isolated temporary package. The root `.scratch` directory is not a workspace package, so a direct task invocation there was not found; copying the fixture outside the workspace resolved task discovery.

Successful fixture output: `/tmp/janitor-repository-fixture-1o7VmL/result.json`.

- The fixture command succeeds before and after host archive restoration.
- The state manifest matches across restoration: local commit and branch, staged and unstaged diffs, staged deletion, untracked file, required ignored file, symlink target, and executable mode.
- A push behind a concurrent human commit is rejected. Fetch/rebase preserves the human contribution and allows subsequent publication to the local bare remote.
- Reading the remote branch ref confirms the expected published commit without another push. This is only a simple local-ref case; later remote commits and ambiguous GitHub PR creation remain untested.

No Cloudflare restore, R2 operation, OpenCode adapter invocation, or GitHub API call was performed. The host archive does not test production overlay behavior, a durable checkpoint-pointer transaction, race fencing, or crash recovery. The fixture deliberately leaves those flags false.

## Local environment

The `docker` command is Podman 5.8.6, not Docker Engine. Available images are PostgreSQL and Alpine, not the Sandbox image. The filesystem had approximately 1.5 GiB free and 38,143 free inodes at inspection. Avoided dependency installation and image pulls while checking the release requirements. The existing OpenCode probe and pinned source were reused for inspection; the root application's dependencies and code were not changed.

## Findings that block a complete claim

1. The SDK backup API accepts positive TTLs and rejects expired metadata at restore time even if the archive still exists. It offers no documented nonexpiring handle or renewal operation. A longer TTL plus periodic re-checkpointing has an outage boundary and cannot silently replace the accepted session-lifetime guarantee. See [backup API](https://developers.cloudflare.com/sandbox/api/backups/) and the [release/source investigation](sandbox-release-retention.md).
2. SDK process support must satisfy the pinned Effect ChildProcessSpawner interface, including input as well as output streams. The release investigation found a stable stdin gap, and preview documentation also explicitly excludes process stdin. A stdout-only command smoke test cannot prove the required adapter. A deliberately implemented process bridge may be needed; switching to preview alone does not solve this gap.
3. Production restore uses an overlay while local restore extracts an archive. Git operations and build caches must be tested on the actual production path. See [backup guide](https://developers.cloudflare.com/sandbox/guides/backup-restore/).

The existing Cloudflare Sandbox + R2 direction still has a plausible implementation. What is not established is that the stable SDK helpers alone fulfill it. A Janitor-owned archive/checkpoint manifest with explicit cleanup is an alternative to expiring SDK backup handles; it requires implementation and R2 restore verification, not a claim that changing an SDK TTL field solves durability.

## Proposed remote fixture, before deployment

Use a separately named disposable Worker and SQLite DO namespace for the runner and workspace control, one Sandbox container instance at a time, and a dedicated R2 bucket. The model remains fake; this experiment needs no paid model calls or team repository access. Keep resource creation and deletion separate from the root app's deployment.

The fixture must invoke file and command operations through the pinned OpenCode Workerd interfaces. Its control endpoint must require authenticated test access and must not expose an unauthenticated remote shell. Use service bindings for internal control where supported. Inject faults only into generated fixture operations.

Before a live run, the reviewable deployment bundle must contain the selected SDK/image digest, runner and adapter code, exact commands and fault cases, checkpoint implementation, estimated resource use and runtime bound, account selection, and a cleanup command covering the Worker, DOs, container, R2 objects, and bucket. This bundle is not yet complete because the process and retention choices remain unresolved. No deployment approval is being requested for an unspecified experiment.

GitHub publication is a distinct phase. Start with the generated local bare remote for filesystem checks. Real App credential refresh/scoping, private-key isolation, PR creation/update, and lost-response reconciliation require an explicitly authorized disposable GitHub repository and App installation. Do not use team repository credentials merely to make the local test pass.

## Acceptance matrix for the remote phase

| Check                   | Required observation                                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider create/connect | Repeated workspace ID adopts the same resource; interrupted creation does not duplicate it                                                           |
| Process contract        | argv/cwd/environment, stdin, stdout/stderr, nonzero exit, signal and cancellation behavior satisfy the pinned Effect interface                       |
| Workspace restoration   | Full fixture manifest matches after destroying and recreating the sandbox                                                                            |
| Consistent checkpoint   | Quiesced writers; failed commands that left edits are saved; failed backup never advances the durable pointer                                        |
| Crash windows           | Distinguish archive upload, pointer commit, and completion reply; reconcile uncertain operations before replay                                       |
| Retention               | Idle and paused work remains recoverable under the selected policy; no hidden TTL expiry                                                             |
| Publication             | Preserve human commits, reject unavailable write access, reconcile successful pushes/PR operations with lost replies                                 |
| Disconnection           | Fence stale operations, prevent recreation, clean orphan checkpoints, preserve already published GitHub work                                         |
| Performance             | Record checkpoint size and elapsed time for this fixture and a representative larger fixture; do not infer acceptable latency from the tiny baseline |

Keep the verification ticket claimed. Resolve only after concrete adapter and remote evidence satisfy the accepted contracts, or return a required behavior tradeoff to the user.
