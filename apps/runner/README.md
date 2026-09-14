# Runner

The runner embeds the pinned OpenCode Workerd SDK in one SQLite Durable Object per agent session. OpenCode owns the conversation, model requests, input inbox, execution recovery, compaction and usage. Janitor supplies repository access, model configuration, maintenance and delivery projections.

Repository files live in the same object's SQLite database. There is no Sandbox container, Git clone, process bridge, container image or registry login. The workspace indexes GitHub's tree and fetches file blobs when a tool needs them. Local edits and their tool receipts commit in one SQLite transaction, so a restart cannot apply an acknowledged edit twice.

## Application and deployment

`stacks/runner.ts` deploys the Worker and session namespace through the root Alchemy stack. The runner uses the root lockfile, Effect version, Vite+ commands and CI. The API calls it through an Alchemy Worker service binding; repository authorization returns through the API binding. GitHub operations use the Git Data REST API with short-lived, repository-scoped credentials issued by the application's existing GitHub integration.

The separate Worker preserves the deployed `AgentRunner` and `AgentSessions` identities and isolates OpenCode's Workerd bundle requirements. Cloudflare does not require a separate Worker. Combining the bundles would require a tested migration of the Worker-owned session namespace; it would not eliminate a container, because this implementation has none. See [the Worker decision](../../docs/adr/0001-runner-worker-and-linux-workspace.md) and [the SQLite workspace decision](../../docs/adr/0002-sqlite-agent-workspaces.md).

| Component                                     | Responsibility                                                          |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| `SessionCommands` / `SessionAdmission`        | Authenticated runner commands and durable input admission               |
| `NativeSession` / `SessionSupervision`        | OpenCode lifetime, alarms, interruption and recovery                    |
| `SessionCompatibility` / `SessionMaintenance` | Migration barriers and maintenance holds                                |
| `SessionProjection`                           | Read-only session status, events and usage                              |
| `RepositoryAuthority`                         | Repository readiness, generation and scoped credentials                 |
| `WorkspaceStore`                              | SQLite file index, lazy blob cache, edits and atomic tool receipts      |
| `GitHubRepository`                            | Bounded GitHub HTTP requests and Git object verification                |
| `WorkspacePublication`                        | Prepared Git objects, fast-forward ref updates and reconciliation       |
| `LegacyWorkspace`                             | Read-only import of confirmed archives from the previous implementation |

`RepositoryWorkspace` composes these services into the OpenCode workspace driver and tool boundary. `Publication` owns the durable PR workflow: branch identity, publication intent, uncertain response reconciliation and teammate explanations.

## Tools and limits

The model receives `read`, `glob`, `grep`, `write`, `edit`, `delete`, `diff` and `publish`. Paths are relative to the repository; `/workspace/repository/…` is accepted for compatibility. Parent traversal, `.git` access and paths outside the repository are rejected. Symlinks and submodules are indexed but never followed or edited.

There is no shell, child process, package installation, local build or project test execution. The model must describe checks it actually observed; publishing a change does not establish that tests passed. Executable validation belongs in the repository's GitHub CI. Projects requiring local code execution need a separately designed execution service.

The workspace admits up to 20,000 indexed files and reads or writes individual blobs up to 1 MiB. GitHub tree responses are checked for truncation; a truncated response triggers bounded directory traversal, never a partial checkout. `glob` uses SQLite glob syntax, where `*` can span directories. `grep` searches literal text with explicit file, byte and result limits. `read` uses character offsets. Results report truncation. Publishing is limited to 500 changed files and 100 KB of preparation metadata per operation; unsupported input leaves edits intact.

Publication constructs immutable blobs, trees and commits through GitHub's Git Data API. Commit metadata is persisted before requests so retries create the same object identities. Ref updates never force-push. Remote changes to an edited file cause a conflict; unrelated human changes are preserved. A lost branch or PR response is reconciled before another write. Subsequent turns update the same PR. A missing base branch, closed or deleted PR branch, unavailable permission or fork write restriction stops publication without discarding local edits.

GitHub's Git Data API requires an initialized base branch. Initialize an empty repository before asking the runner to publish. Conflicts require teammate resolution; the runner does not overwrite the remote decision automatically.

## Configuration

Existing model and service credentials remain:

- `JANITOR_AGENT_RUNNER_TOKEN`: API-to-runner authentication.
- `REPOSITORY_SERVICE_TOKEN`: runner-to-API repository authorization (bound as `REPOSITORY_SERVICE_TOKEN`).
- `JANITOR_AGENT_RUNNER_MODEL_API_KEY`: provider credential; OpenRouter is supported by the checked-in model configuration.
- `JANITOR_AGENT_RUNNER_MODEL_CONFIGURATIONS`: optional override of the versioned model records.

Alchemy supplies `SESSIONS`, `REPOSITORY_AUTHORITY` and the release identity. The retained `WORKSPACE_CHECKPOINTS` bucket is used only to import old sessions; new workspaces do not write archives. No container registry credential or Sandbox configuration is needed.

## Upgrade and recovery

Keep the Worker and Durable Object resource names unchanged. State format 3 and family `janitor-runner-sqlite-1` identify SQLite workspaces. The release reads the previous Janitor state formats and retains native OpenCode migration guards. Older releases refuse the new family; rollback after migration requires an explicit data migration, not a blind redeploy.

For an existing repository session, the runner verifies the last confirmed archive's framing, checksum and available identity manifest, identifies the archived remote branch, and imports repository files and deletions atomically. The original R2 object and checkpoint pointer remain available for recovery. Git object history stays in the retained archive; unpublished working files become SQLite edits. Native conversation state remains in place.

An unknown legacy tool outcome, missing archive, unsupported file, unidentifiable remote branch or incompatible manifest blocks migration. Use the previous release to reconcile that session or recover its retained archive before cutover. Do not clear its state to make it appear fresh. Drain old sessions before deployment and review Alchemy's plan: retain the checkpoint bucket and session namespace. The retirement-only provider in `deployment/RetiredRunnerResources.ts` lets Alchemy forget retained image resources without a registry operation. Keep it until every deployed stage has transitioned. The deployment token still needs its existing Containers permission to remove the old container resource during cutover; it can be narrowed afterward. Removal of old container resources is a deployment operation; this code change does not delete live infrastructure.

## Validation

From the repository root:

```sh
vp install
vp check
vp run runner:check
vp run runner:build
vp test
vp run dev
# In another terminal, after the local API and runner are ready:
vp run runner:smoke
```

The native tests run the production OpenCode host in Miniflare with SQLite and controlled model/GitHub HTTP boundaries. They cover durable inputs, model deployment and credential rotation, compaction, tool recovery, file access, PR reconciliation, maintenance and migration. They do not need Docker. The full local application still uses Docker or Podman for PostgreSQL.

Local development uses a disposable GitHub fixture and controlled model responses. Set `JANITOR_LOCAL_LIVE_MODEL=true` with a configured provider credential to exercise real model requests. Paid model and live GitHub publication tests are opt-in; see [model validation](MODEL-VALIDATION.md). Normal CI does not create remote PRs or call a paid model.
