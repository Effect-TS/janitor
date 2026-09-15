# Sandbox and session coordinator research

Researched 2026-09-14. This is evidence for a design interview, not an accepted architecture or implementation plan. The user wants Linux sandboxes back without recreating the earlier process bridge and expensive default development/test setup.

## Baseline and constraints

The inspected branch is `feat/runner-project-integration` at `7dad92c`; PR 39 remains open. Its SQLite implementation is not evidence of what production currently runs. [PR 39](https://github.com/Effect-TS/janitor/pull/39)

[ADR 0001](../../docs/adr/0001-runner-worker-and-linux-workspace.md) retains the runner Worker to preserve deployed namespaces and its OpenCode bundle requirements. A separate Worker is an application choice. [ADR 0002](../../docs/adr/0002-sqlite-agent-workspaces.md) chose SQLite files and no shell; restoring Linux execution requires superseding that decision. [CONTEXT.md](../../CONTEXT.md) already requires ordered input handoffs, catch-up obligations, disconnection cleanup, and maintenance fencing. Those requirements should be challenged explicitly if their cost no longer fits the product.

## What Cloudflare already supplies

Sandbox SDK has three layers: application code, its Sandbox Durable Object, and a Linux container. The Sandbox object owns identity, lifecycle, and routing. Calls through `getSandbox()` reach that object; the SDK already supplies its container transport. We do not need to invent an HTTP shell server merely to execute commands or manage files. [Sandbox architecture](https://developers.cloudflare.com/sandbox/concepts/architecture/)

The lower-level `Container` class extends Durable Object and exposes SQLite storage and lifecycle hooks. Consequently, one application subclass can combine coordinator state and container management; two DOs are not a platform requirement. Keeping Janitor's existing session DO separate from the SDK's Sandbox DO remains an option when preserving its namespace and isolating lifecycle ownership is more valuable than removing a hop. [Container interface](https://developers.cloudflare.com/containers/reference/container-class/)

**Version distinction:** current official docs describe both a stable API and a materially different 1.0 preview. Stable uses string `exec`, `execStream`, and `startProcess`. Preview uses argv `exec` returning a process handle. Do not design against preview methods while retaining an older stable package/image. [Commands](https://developers.cloudflare.com/sandbox/api/commands/)

Stable background-process support includes listing processes, readiness by port or log, and explicit process environment and working directory. A background process is suitable for an OpenCode HTTP server if that placement is chosen. [Background processes](https://developers.cloudflare.com/sandbox/guides/background-processes/)

Stable shell sessions preserve shell state while sharing the same filesystem and process space. They are not independent agent isolation boundaries. Preview removes these session execution APIs and takes working directory/environment per command. Use distinct vocabulary for Janitor's durable **agent session** and an SDK shell session. [Sessions API](https://developers.cloudflare.com/sandbox/api/sessions/)

## Lifecycle and recovery facts

A stable sandbox ID is not a durable Linux machine. The default inactivity timeout is ten minutes; after idle shutdown the next request starts a fresh container and the old files/processes are gone. `keepAlive` prevents idle shutdown, not arbitrary failures. Package and image versions must be kept compatible. [Sandbox lifecycle](https://developers.cloudflare.com/sandbox/concepts/sandboxes/)

Cloudflare documents ephemeral container disks and still describes native snapshots as forthcoming. Container hooks include `onStart`, `onStop`, `onActivityExpired`, and `onError`. These are useful for controlled shutdown but do not establish a guarantee that a final backup can happen before every failure. [Container lifecycle](https://developers.cloudflare.com/containers/concepts/architecture/)

In the 1.0 preview, process handles and replay cursors belong to the current container. `logs({ since, replay, follow })` can resume buffered output; truncation is explicit. Cancelling a wait or stream does not kill the process, and bounded `output({ maxBytes })` prevents uncontrolled buffering. These are useful building blocks, not a durable application event journal. [Preview processes API](https://developers.cloudflare.com/sandbox/1-0-preview/api/processes/)

Preview errors distinguish a container that never started work from an interrupted call that may have changed state. `ContainerUnavailableError` allows retry after backoff. `OperationInterruptedError` and `RPCTransportError` require inspection or idempotent recovery. Stale process handles cannot recover a previous container's work. This is explicit evidence against a generic retry-everything wrapper around shell commands. [Preview errors and recovery](https://developers.cloudflare.com/sandbox/1-0-preview/errors/)

DO alarms provide at-least-once execution, with one scheduled alarm per object and up to six automatic retries. Long outages require application rescheduling rather than assuming infinite platform retries. Multiple due activities can share one persisted schedule. **Inference:** the coordinator should persist recovery obligations and inspect current state when woken, rather than depend on an open stream or an in-memory fiber forever. Combining coordinator and Sandbox into one class requires understanding the SDK's own alarm ownership. [DO alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)

## Built-in backups and their limits

`createBackup` uploads a directory archive to R2 and returns a serializable handle. The API supports exclusions, compression, and multipart uploads. Partially written files may be inconsistent. Production requires a backup bucket plus presigned-URL credentials; default TTL is three days, and expiry is checked at restore time rather than deleting objects automatically. **Inference:** completed turns need a deliberate backup publication boundary, explicit retention, and quiescence if consistency matters. This is not an atomic transaction with the coordinator's SQLite database. [Backups API](https://developers.cloudflare.com/sandbox/api/backups/)

Production restore mounts squashfs as a read-only lower layer with a writable overlay. Restoring again discards that upper layer. Local development extracts the archive instead. Cross-device directory renames can fail in production; Cloudflare specifically calls out Vite's generated dependency cache. Therefore a Docker/local test cannot prove production restore behavior. [Directory backups](https://developers.cloudflare.com/sandbox/concepts/backup-restore/)

Bucket mounts offer persistent object-backed files and can use Worker R2 bindings without exposing credentials to the container. Production mounting overlays the target directory; local mode periodically synchronizes files and has different visibility semantics. The docs do not establish the locking, crash consistency, or performance required for putting OpenCode's live SQLite database on such a mount. Treat that proposal as unverified, not as an easy durability substitute. [Mount buckets](https://developers.cloudflare.com/sandbox/guides/mount-buckets/)

**Design implication:** use native backup APIs before writing another archive protocol, but choose what is being promised. Preserving completed-turn workspace changes is cheaper than guaranteeing that every acknowledged shell mutation survives sudden loss. A consistent OpenCode database backup is a separate concern when OpenCode itself runs in the container. A Git branch alone does not preserve untracked files, pending inputs, conversation state, or partial work.

## Credentials and repository execution

Cloudflare isolates sandboxes in separate VMs, but all processes within a sandbox share files, process visibility, and localhost. A repository script is therefore inside the same trust boundary as any credentials given to its OpenCode process. Distinct shell sessions do not change this. [Sandbox security model](https://developers.cloudflare.com/sandbox/concepts/security/)

Outbound handlers run trusted Worker code and can inject credentials without giving the secret to the container. They can constrain destinations and requests; the Worker must export `ContainerProxy`. Internet access is allowed by default, and an allowlist changes the egress policy. **Inference:** a repository-scoped GitHub proxy and model proxy could reduce secret exposure for an in-container OpenCode host. The proxy still needs to authorize repository/method/operation and enforce spend; hiding the secret does not prevent the sandbox from using allowed capabilities. [Outbound traffic](https://developers.cloudflare.com/sandbox/guides/outbound-traffic/)

## OpenCode placement options

The v2 embedded SDK hosts OpenCode inside the caller and routes generated client calls in memory. It is distinct from the network client. Its Cloudflare integration supplies a DO host with SQLite persistence and durable event support. [Embedded SDK](https://opencode.ai/v2/docs/build/sdk), [Cloudflare host](https://opencode.ai/v2/docs/build/sdk/cloudflare)

These are options to interrogate, not decisions:

| Option                                                                   | Benefit                                                                                     | Main obligation                                                                                                          |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| OpenCode in existing session DO; Sandbox runs filesystem and Linux tools | Keeps conversation durability and current session ownership; credentials can stay in Worker | Adapt tool/filesystem/process capabilities to SDK methods; coordinate workspace recovery with native tool receipts       |
| OpenCode host/server in Sandbox; DO coordinates input and progress       | Native Linux tools and files remain together; fewer remote tool calls                       | Persist or back up native conversation DB and workspace consistently; reconcile admissions and stream gaps after restart |
| Janitor coordinator subclasses Sandbox/Container directly                | One DO identity and lifecycle owner                                                         | Namespace migration, SDK alarm/storage integration, and native host composition require investigation                    |

A generated network client does not by itself supply durable admission, replayable events, or exactly-once external effects. The selected OpenCode version's server semantics must be verified before claiming those guarantees. The existing embedded host's capabilities should not silently be attributed to an arbitrary `opencode serve` binary.

## Proposed interaction contract to discuss

Keep the domain contract smaller than the transport. A possible boundary is: prepare or restore a workspace; submit a turn or tool operation; inspect it; observe progress; cancel it; save durable state; destroy it. Whether the unit submitted is a whole turn or one tool depends on OpenCode placement.

The coordinator would durably record accepted inputs and their stable IDs, current attempt/generation, native session identity, last confirmed backup, pending delivery, and the next reconciliation time. The container would own the current process and filesystem. Live streams would improve feedback; persisted state and inspection would recover missed updates. This is a proposal, not a claim about SDK guarantees.

Failure behavior needs explicit answers:

1. Container unavailable before execution: retry setup with backoff and show the current stage.
2. Lost response while execution may continue: inspect receipt/process/state before resubmitting.
3. Container replacement: restore the last confirmed state, then either resume, retry the interrupted turn, or require user intervention according to the chosen durability contract.
4. GitHub write with unknown outcome: inspect the published branch/PR before repeating it; restoring files cannot undo an external effect.
5. Slack disconnect: continue recording results and reconcile delivery independently of model execution.
6. Planned deployment: finish or interrupt according to policy and preserve a consistent recovery point before replacement; no success claim merely because a shutdown hook ran.

## Alchemy and CI evidence from the repository

The pinned Alchemy `2.0.0-beta.76` [Container resource implementation](../../node_modules/alchemy/src/Cloudflare/Containers/Container.ts) supports a container class with `context`/`dockerfile` or an `image`, and also an Effect-native `main`/`.make` path. Arbitrary Sandbox images do not automatically gain the latter's Effect RPC behavior. The removed implementation at commit `be9f4dd` used a custom image resource in `stacks/runner.ts` and custom process/stdio transport in `apps/runner/src/RemoteProcess.ts`. Those are candidates for replacement with supported resources/APIs, subject to a small real deployment check.

[CI run 34909442948](https://github.com/Effect-TS/janitor/actions/runs/34909442948) took 9m38s: `vp test` 8m7s, local Alchemy smoke 29s, installation 29s, `vp check` 21s, runner typecheck 2s, and runner build 2s. The root [runner check script](../../package.json) only typechecks; it does not run a duplicate suite. [Runner Vitest configuration](../../apps/runner/vite.config.ts) disables file parallelism, and [test setup](../../apps/runner/test/support/globalSetup.ts) builds a test bundle. Whole-suite timing does not prove every minute belongs to runner tests; profiling is needed before attributing or removing coverage.

**Proposed validation split:** fast Effect service tests for ordered admission, recovery decisions, cancellation, and publication reconciliation; a small workerd test for actual DO persistence/bindings; an opt-in or separately gated deployed smoke for container startup, native tools, backup/restore, and shutdown. Avoid rebuilding a complete local cloud simulation as the default developer workflow. Decide a measurable CI budget and which deployment checks block release before writing the new test matrix. Local emulation remains useful for application behavior, but Cloudflare's documented restore/mount differences make live validation necessary for those semantics.

## Unsettled decisions and verification gaps

- Recovery promise: preserve every completed tool mutation, completed turns, or only published GitHub work? What interrupted work may be retried or lost?
- OpenCode placement and whether retaining current native admission/recovery is a requirement.
- One sandbox per agent session, pooling, or another identity rule; concurrent private threads must not accidentally share a mutable checkout.
- Stable versus preview Sandbox API and exact package/image pin. No target release was installed or deployed during this research.
- SDK alarm composition and existing namespace migration if coordinator and Sandbox DO are merged.
- Consistent native database backup/restore if the host moves into Linux; live SQLite-on-R2 is not established by these sources.
- Whether built-in backups preserve all repository metadata and operations needed by Janitor on the chosen image; verify modes, symlinks, ignored work, `.git`, and generated-cache exclusions with one focused deployed check.
- Whether supported Alchemy image building works with this stack's dependency graph without the old custom provider; inspect existing provider failure history before deleting it.
- User-facing acknowledgement and progress timing targets, execution timeouts, retention, idle cost, and CI budget.

No code was changed, no cloud resources were provisioned, and no design option above has been accepted.

## Follow-up: one coordinator and Sandbox DO

Consolidation is supported by the class hierarchy: `Sandbox<Env>` extends `Container<Env>`, which extends Durable Object. A Janitor subclass can expose coordinator RPC methods and keep its own tables in `this.ctx.storage` while invoking inherited sandbox operations. The inspected Sandbox source declares package version `0.12.9`; its `onStart` and `onStop` implement runtime identity, session invalidation, and connection cleanup. Preserve those superclass hooks when adding Janitor behavior. [Sandbox source at c5891f5](https://github.com/cloudflare/sandbox-sdk/blob/c5891f511baab8116d445ee8952adcb1c53f91a3/packages/sandbox/src/sandbox.ts), [package metadata](https://github.com/cloudflare/sandbox-sdk/blob/c5891f511baab8116d445ee8952adcb1c53f91a3/packages/sandbox/package.json)

Cloudflare explicitly directs subclasses to use inherited `schedule(when, callback, payload)` instead of overriding `alarm()`, because the latter also manages container lifecycle. Use application-named callbacks and tables; do not let an independent Janitor alarm implementation overwrite the SDK schedule. [Container scheduling](https://developers.cloudflare.com/containers/reference/container-class/#schedule)

The inspected Containers implementation creates `container_schedules` in the same SQLite database. Its alarm handler catches a scheduled callback's error, logs it, and deletes that one-time schedule. Thus throwing from a callback does not automatically retry Janitor work. A coordinator callback must retain its durable recovery obligation and explicitly schedule subsequent attempts when needed. This finding is from upstream commit `a17055c`; verify the exact resolved Containers dependency before implementation. [Container scheduler source](https://github.com/cloudflare/containers/blob/a17055ca4f64b8f7fea6dfaa62dfb2c06a954a2b/src/lib/container.ts#L1976)

This removes the need for a separate sandbox-management DO, but does not settle OpenCode placement. It also does not establish a safe migration for existing live session namespaces; that is a separate deployment concern.
