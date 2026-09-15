# Runner

Each agent session is one Durable Object that extends Cloudflare's Sandbox class: it owns the session's Linux container, hosts the pinned OpenCode Workerd SDK with the conversation in Durable Object SQLite, and coordinates turns, recovery and teammate decisions. The container holds the repository checkout, runs commands and background processes, and is backed up to R2 after every completed turn.

## Application and deployment

`stacks/runner.ts` deploys the Worker, the container-backed `SandboxSession` namespace, the sandbox image and the backup bucket through the root Alchemy stack. Containers can only be enabled on a Durable Object class when it is created, which is why the class name changed at cutover. The runner uses the root lockfile, Effect version, Vite+ commands and CI. The API calls it through an Alchemy Worker service binding; repository authorization returns through the API binding.

The image in `container/Dockerfile` is Cloudflare's Sandbox runtime plus Git, ripgrep and build tools. Repository commands run as the unprivileged `janitor` user; the Sandbox control server stays root. `container/dev/Dockerfile` adds a bare fixture repository so local development clones and publishes without GitHub.

| Service                                | Owns                                                                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `SessionCoordinator`                   | Admission and deduplication, attempt identity, queue gating after interruption, deadlines, progress events, Retry and Skip |
| `Host` / `TurnHost`                    | The OpenCode runtime, model configuration and credentials, running one input to a terminal outcome, cancellation           |
| `SandboxTools`                         | The `bash`, `read`, `write`, `edit`, `glob`, `grep`, `list` and `publish` tools over the sandbox                           |
| `SandboxWorkspace`                     | The sandbox port: commands, files, process control, backups; implemented by the object over the Sandbox SDK                |
| `RepositoryCheckout`                   | Reusing a live workspace, restoring the latest recovery point or cloning, then reconciling publication effects             |
| `RecoveryStore`                        | Backup capture, the authoritative pointer in SQLite, restore and obsolete-backup deletion                                  |
| `WorkspacePublication` / `Publication` | Git preparation, guarded pushes and inspection in the sandbox; PR creation and reconciliation through GitHub               |
| `RepositoryAuthority`                  | Repository readiness, generation and short-lived scoped credentials from the API                                           |

## Turn contract

1. An input is durably accepted and acknowledged before any container starts; later inputs queue in acceptance order.
2. A turn reuses the live workspace when it still matches the last recovery point, otherwise restores that point or clones the repository, then reconciles uncertain publication outcomes.
3. OpenCode runs in the object; tools call the owned sandbox. Commands default to ten minutes and turns to thirty (`JANITOR_COMMAND_TIMEOUT_MS`, `JANITOR_TURN_TIMEOUT_MS`).
4. When the model finishes, background processes stop and a backup of `/workspace/repository` is uploaded, omitting only disposable caches. The pointer, the completed-turn record and the reply event commit together; the previous backup is deleted afterwards.
5. Saving retries within `JANITOR_SAVE_RETRIES` without rerunning the model. Persistent failure is reported as `turn.save_failed`, not success.
6. Anything short of a committed recovery point leaves the session waiting: later inputs stay queued until a teammate retries or skips the interrupted attempt. The next attempt restores the last recovery point and is told so. Native OpenCode recovery is inert; the object never restarts a model turn on its own.

The runner emits `turn.*` events (see `src/Protocol.ts`) that the API projects to the dashboard and Slack. Stale Retry or Skip actions and repeated clicks are refused by identity.

## Authority

Repository scripts are untrusted. The model's shell has no GitHub credentials; clone and publication run Git with a short-lived, repository-scoped token in the environment of one authenticated command, after stopping background processes. Model credentials never enter the container. Publication creates or updates the session's pull request through GitHub after verifying the push, and inspects uncertain outcomes before repeating a write.

## Configuration

- `JANITOR_AGENT_RUNNER_TOKEN`: API-to-runner authentication.
- `REPOSITORY_SERVICE_TOKEN`: runner-to-API repository authorization.
- `JANITOR_AGENT_RUNNER_MODEL_API_KEY`: provider credential; OpenRouter is supported by the checked-in model configuration.
- `JANITOR_AGENT_RUNNER_MODEL_CONFIGURATIONS`: optional override of the versioned model records.
- `JANITOR_SANDBOX_R2_ACCESS_KEY_ID` and `JANITOR_SANDBOX_R2_SECRET_ACCESS_KEY`: an R2 API token for the backup bucket. Production containers upload backups directly through presigned URLs; local development uses the bucket binding.

Alchemy supplies `SESSIONS`, `BACKUP_BUCKET`, `REPOSITORY_AUTHORITY` and the release identity. Backups are created with a ten-year expiry so the latest recovery point cannot expire during a session; the runner deletes obsolete ones itself. Restoring in production mounts the backup as a read-only layer with a writable overlay; cross-device renames inside the checkout (for example Vite's dependency cache) can fail there, unlike the local extraction.

## Cutover and deployments

The first deployment retires every existing session: migration `0032_sandbox_runner.sql` ends them, drops their pending handoffs and Slack threads, and leaves cleanup tombstones so each old runner object is cleaned and fenced. Runner objects written by earlier releases refuse work until that cleanup reaches them. Later deployments retain sessions and may interrupt active turns; affected sessions wait for Retry or Skip.

## Validation

From the repository root:

```sh
vp install
vp check
vp run runner:check
vp run runner:build
vp test
```

The runner tests run in Node against Node's SQLite and scripted sandbox, model and recovery ports. They cover admission ordering and deduplication, interruption gating and Retry/Skip, recovery pointer ordering and save retries, workspace reuse and restore, publication reconciliation after a lost push, and turn timeouts. Nothing in the default checks needs Docker.

The optional local smoke (`vp run dev`, then `vp run runner:smoke`) runs a controlled turn against a real container, destroys the container and checks that the next turn restores the recovery point. Set `JANITOR_LOCAL_LIVE_MODEL=true` with a configured provider credential to exercise real model requests. Paid model and live GitHub publication checks are opt-in; see [model validation](MODEL-VALIDATION.md).
