# Janitor agent runner

The runner is a separately built Cloudflare Worker with one SQLite Durable Object per agent session. Each object hosts the pinned OpenCode Workerd SDK (`@opencode/sdk/workerd/effect`, published packages `@opencode/*` 2.0.2) and owns the native conversation, inbox, execution claims, durable events and usage. Janitor talks to it only through the versioned JSON command boundary in `src/Protocol.ts`.

## Why a separate workspace

The published SDK depends on the registry Effect `4.0.0-rc.112` graph. Janitor's root workspace pins a pkg.pr.new Effect snapshot with global overrides, and the two graphs are not interchangeable. This directory is its own pnpm workspace (`pnpm-workspace.yaml`, `pnpm-lock.yaml`) so neither side's overrides can silently replace the other's dependencies. The root `vp` checks ignore this directory; run the runner's own checks from here.

## Setup

```sh
cd runner
pnpm install
```

The OpenCode packages are exact registry versions in `package.json`; upgrading them is a release decision (see the upgrade contract) because the native migration set and protocol may change.

## Checks

```sh
pnpm typecheck   # runner sources against the published declarations
pnpm build       # dist/worker.mjs, the deployable bundle
pnpm test        # builds dist-test/worker.mjs and runs the Miniflare scenarios
```

The test bundle (`test/worker.ts`) wraps the production runner with a scripted model transport and fault injection reachable only under `/__test/`. The production bundle contains none of it.

`scripts/serve.mjs [--test] [--port N] [--persist DIR]` serves a bundle through Miniflare and prints one JSON line with the URL and service token. Janitor's acceptance driver (`apps/cluster/test/Agent/AcceptanceDriver.test.ts`) uses it.

## Configuration

The Cloudflare Worker is named `janitor-agent-runner`. Use the `JANITOR_AGENT_RUNNER_` prefix for its deployment configuration so these settings are distinguishable from GitHub Actions runners.

Janitor needs `JANITOR_AGENT_RUNNER_URL`, the agent runner's HTTPS base URL, and `JANITOR_AGENT_RUNNER_TOKEN`. The same token is a secret binding on the agent runner. The earlier `RUNNER_SERVICE_URL` and `RUNNER_SERVICE_TOKEN` names are no longer read.

| Binding                                     | Purpose                                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `JANITOR_AGENT_RUNNER_TOKEN`                | Bearer token Janitor presents on every command.                                                                           |
| `JANITOR_AGENT_RUNNER_MODEL_CONFIGURATIONS` | JSON `{ default, records[] }` of immutable model configuration records (`src/ModelConfiguration.ts`). No key values.      |
| `JANITOR_AGENT_RUNNER_RELEASE`              | Release identity recorded in each object's compatibility record.                                                          |
| `<record.secretBinding>`                    | One secret binding per provider credential, read at request time only. Rotate through deployment; records stay unchanged. |

A session selects the default record at creation and keeps it; changing the default affects new sessions only. A missing secret or retired record is a visible execution failure, never a substitute model.

Use `JANITOR_AGENT_RUNNER_MODEL_API_KEY` for the provider secret and set the model record's `secretBinding` to that name. Other explicit binding names remain supported. In GitHub's `production` environment, store the URL and model configurations as variables, and the service token and provider key as secrets. Set `JANITOR_AGENT_RUNNER_RELEASE` from the deployed commit SHA. CI must explicitly pass each value to the corresponding deployment.

## Command boundary

All routes require the bearer token and `x-janitor-runner-protocol: 2`.

| Route                                       | Command                                                                                   |
| ------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `PUT /v1/sessions/:id`                      | Idempotent creation with a generation; the native conversation identity is deterministic. |
| `POST /v1/sessions/:id/inputs`              | Durable admission by stable `msg_` id; returns the existing or new receipt.               |
| `GET /v1/sessions/:id`                      | Inspection without constructing a host: execution state, reason, supervision, usage.      |
| `GET /v1/sessions/:id/events?after=&limit=` | Exclusive-cursor read of durable events plus replay-safe cumulative usage.                |
| `POST /v1/sessions/:id/maintenance`         | Operator hold/release by epoch; holds quiesce the host and preserve wake obligations.     |
| `DELETE /v1/sessions/:id`                   | Generation-fenced cleanup leaving only a tombstone.                                       |

Errors carry `{ code, message, reason? }` with distinct codes: `unauthorized`, `incompatible_protocol` (426), `invalid_request`, `stale_generation` (409), `missing_session` (404), `blocked` (423) and `transport` (503, retryable with the same identities).

## Supervision

Admission persists the wake obligation and arms the alarm before native admission. The alarm rearms before fallible inspection, wakes pending native work, lets native recovery own orphaned claims with its ten-resumption accounting, and clears itself only after rechecking the supervision revision. Maintenance holds, compatibility guards (`_janitor_*` compatibility record and the native migration journal) and persisted blockers are checked before any host construction. The model transport applies the five-minute inactivity deadline at the HTTP boundary; native provider retries and Retry-After remain intact. The structured question tool is not advertised; commands must be foreground with a finite timeout.

## Deployment

`wrangler.jsonc` packages `dist/worker.mjs` with the `SESSIONS` SQLite Durable Object class. Provisioning bindings and secrets per stage, and validating a real provider, belong to the deployment tickets; nothing here deploys.

## Repository execution

Creation accepts an optional `repositoryId`, the numeric GitHub identity selected in Janitor. Selection is immutable. Janitor stores it on `agent_session` and includes it in the ordered creation handoff. Sessions without a selection have no tools. Selected sessions expose native `read`, `glob`, `grep`, `write`, `edit`, foreground `shell`, and Janitor's `publish` tool. The synthetic `execute` tool, structured questions, and direct session-shell/background entry points remain disabled.

The runner protocol is now **2**, including on the existing `/v1/` routes. An older runner must reject the new caller instead of silently dropping repository selection. Existing protocol-1 compatibility records remain held for the guarded upgrade procedure; this change does not rewrite them or reset sessions.

Provision `SANDBOXES` with the exported `Sandbox` class and a private `REPOSITORY_AUTHORITY` service binding to the stage's Janitor Worker. Set the same `REPOSITORY_SERVICE_TOKEN` secret on both Workers. The authority checks session generation, selected repository, connection, access and synchronization readiness on every request, including cache hits. It caches tokens by installation, numeric repository and permission set, refreshing within one minute of expiry or after invalidation. Clone and fetch use Contents read, push uses Contents write, and PR API calls use Pull requests write. The GitHub App installation must grant those permissions. Its private key stays in Janitor.

`RepositoryWorkspace` derives the resource name from the session, generation and repository, saves its identity before allocation, and adopts the existing bridge process on reconnect. It authenticates `containerFetch` requests on port 8788 and checks the running bridge's protocol, capabilities, generation and epoch before dispatch. No preview port or public bridge route is configured.

Runner SQLite saves immutable operation admission before dispatch. The bridge commits admission before spawn, records sequenced binary stdin and output, and contains each process in a PID namespace under a separate workspace user. This user cannot read the bridge process environment or write its journal. Lost responses retry the same identity within the same epoch. Changed epochs and unresolved admissions hold recovery for reconciliation. Bridge journals survive process restart; runner admission records survive container loss. Tool admission also precedes native execution. A tool result is released only after its workspace archive and saved result commit together in runner SQLite. A changed bridge epoch restores the last committed archive only when no operation is uncertain.

Clone credentials exist only in the controlled Git process environment. Credential helper configuration is per invocation, clone URLs contain no credentials, and clone output is discarded. The operation journal records repository identity and outcome without the token. Cleanup fences the workspace before container destruction and can retry after a failed destruction.

## New-work publication

After committing and testing changes, the agent calls `publish` with a title, a substantive body including validation, and an optional base branch. The default base comes from GitHub. The session, generation and repository determine one stable `janitor/<sha256>` branch. Slack conversations already associated with a PR cannot use this new-work path; existing-PR updates belong to the next implementation slice. Repeated calls after completion return the recorded PR.

Publication stops workspace processes and copies regular Git object files into a private temporary repository. It ignores workspace Git config, hooks, replacement refs and alternates. Credentials reach only controlled network Git commands, and push uses an explicit repository URL and branch refspec without force. A private worktree merge supports the image's Git 2.34, incorporates fetched human commits, and reports conflicts without changing the agent's work. The designated local branch and merged commit are checkpointed before push.

Runner SQLite records the preparation identity and intended commit, head and base before remote writes. The bridge journals preparation receipts without credentials, allowing a lost response or interrupted checkpoint upload to recover the same result. Remote refs establish whether a push landed; matching PRs use a stable marker and numeric head/base repository identities. PR head SHA may lag the ref. An uncertain PR creation never triggers another POST. Pending publication blocks ordinary repository tools until reconciliation. Confirmed denied or invalid writes preserve work and permit a retry on the same branch.

The durable native tool result includes the PR association and summary. Slack consumes that result, saves `slack_thread.pr_number` and queues the summary and link even if the model never produces a final answer. Tool failures also reach the thread. Publication does not merge PRs.

The native publication test uses local Workerd, SQLite, R2 and the production bridge image with real Git repositories. It exercises divergent human commits on the pinned image, lost preparation/push/PR responses, checkpoint interruption, readiness loss, denied and invalid PR writes, credential exclusion and duplicate prevention. GitHub responses are controlled fixtures. Live GitHub permissions, branch protection and deployed service bindings require separate acceptance evidence.

## Repository checks and image provenance

Run commands from `runner/` through Vite+:

```sh
vp install
vp run typecheck
vp run test:bridge
vp run test
vp run build
vp run build:bridge --record
```

Runner tests build the local image and require Docker or a compatible Podman CLI. The repository acceptance driver supplies preloaded repositories and a controlled credential authority at service boundaries, then runs the production bridge image, runner SQLite and native tools. It covers two sessions, lost creation and process responses, stale generations, readiness, incompatible image capabilities and repeated cleanup. The bridge tests also clone through real Git against a local authenticated HTTP repository and check credential exclusion, binary stdin replay, output cursors and cancellation. These are local checks, not a deployed Cloudflare or live GitHub acceptance claim.

`bridge/release.json` records the built image manifest digest, image ID, base image, bridge/Sandbox versions and installed tools. `vp run build:bridge --record` deliberately updates that manifest for a release candidate. Publishing that exact image and binding production services remain deployment work. Changing the Dockerfile or bridge requires rebuilding and recording a new digest.

## Workspace checkpoints

Provision the private R2 binding `WORKSPACE_CHECKPOINTS` separately for each stage. The checked-in binding name is `janitor-workspace-checkpoints`; test runs use local Miniflare R2. No bucket is provisioned by local tests.

The runner serializes native repository tools. Shell commands receive a fixed public environment; Workerd process environment bindings and runner secrets are not forwarded. The bridge drops to a separate workspace user before starting the process namespace, then applies caller environment variables inside that namespace. Workspace commands cannot read the bridge's process environment or journal. Checkpoint Git index inspection disables repository hooks and uses a credential-free environment. Successful tools and failed commands both freeze the workspace, stop command descendants, transfer shell captures to `/workspace/.janitor-captures/`, upload an archive, and commit its pointer together with the tool result. Capture notices name these readable paths outside the Git repository. The bridge stays frozen if checkpointing fails. A retained tool admission blocks dependent work and native recovery until its outcome is reconciled; a new epoch never permits blind replay.

Archives use the versioned `janitor-workspace-2` format with a SHA-256 checksum. They preserve the Git directory, index, local commits, working tree, ignored data, file modes and relative symlinks within the workspace. Restore verifies the hash and validates all entries before replacing workspace contents from a clean staging directory. Untracked credential stores `.ssh`, `.aws`, `.git-credentials`, and `.env*` are excluded, as are untracked reproducible caches `node_modules`, `.cache`, `.pnpm-store`, and `.npm`. Tracked files and their parent directories are retained, including templates such as `.env.example`. Arbitrary file content is not scanned for secrets; controlled Git credentials never enter workspace files. Required ignored files are retained unless they match those explicit exclusions.

Archives stream in 64 KiB file chunks through the runner into R2 with a verified SHA-256 checksum. Restore streams to temporary disk storage and validates before replacing workspace contents. Archive size is not tied to Worker memory. The bridge's existing 8 MiB per-command output limit still applies. Unsupported special files, links escaping the workspace, extra descriptors, pipeline objects, inherited stdio, and alternate process-shell options fail explicitly. Ordinary shell pipelines and binary process streams are supported. Shell deadlines default to two minutes and permit explicit positive finite values.

Upload intents are durable before R2 writes. The previous archive stays referenced until replacement commit. Supervision prunes unreferenced objects using retained upload intents, including while execution is held; failed deletions remain retryable. Session cleanup deletes all archives and refuses to erase its cleanup records while an upload is still settling.

The local acceptance test runs native edits, failed and timed-out shell commands, large-output reads, two isolated sessions, Sandbox replacement, and runner crashes on each side of pointer commit. The bridge restoration test separately verifies staged and unstaged content, local Git commits, ignored data, binary bytes, modes, symlinks, hash rejection and capture-path protection. These checks use local containers, Workerd and R2, not a live Cloudflare deployment.
