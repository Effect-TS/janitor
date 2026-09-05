# Repository onboarding and offboarding

Status: implemented. See [Repository connections](repository-connections.md) for setup and operating details.

The original plan below records the intended behavior. The picker uses a Connect action on each repository row. Reconnection remains available through the persistent switcher action.

## Starting point

The app discovers GitHub App installations and their repository inventories.
`GitHubRepositoryRecord` already separates observed GitHub access from an
`enabled` flag. `SyncPlanner.setRepositoryEnabled` bootstraps labels, entities,
and pull requests when enabled. It is exposed through an operator script, not
a connection flow in the SPA. Reconciliation already checks the enabled flag.
The repository switcher lists repositories and has an empty message, but no
connect action.

Keep the existing Cloudflare Access authentication and trusted-operator model.
Do not treat a GitHub installation ID returned in a URL as authorization. If the
app later supports separate customer accounts, account-scoped authorization is
a prerequisite to exposing repository discovery to those accounts.

## Product decisions

- Use one connection page for both the first and subsequent repositories.
- GitHub access means Janitor can discover a repository. Connection means an
  operator explicitly chose to manage it in Janitor. Pause stops work while
  keeping the repository in the workspace. Disconnect removes it from the
  workspace and stops work, while retaining its configuration for reconnection.
- Do not automatically connect every repository in an installation, including
  repositories added later under an all-repositories installation.
- Connecting does not create rules, modify labels, or enable AI consent.
- Disconnecting does not delete GitHub labels, policies, rules, or history, and
  does not uninstall the GitHub App. State this in the confirmation.
- Permanent data deletion is a separate future action, not a checkbox in this flow.

## First repository

1. After the repository list loads successfully and contains no connected
   repositories, `/` shows a centered welcome state with a repository icon,
   “Connect your first repository,” a short explanation, and **Connect repository**.
   Hide repository-specific navigation. A failed request gets retry UI, never
   this empty state.
2. Open `/repositories/connect`. Show a searchable repository picker grouped by
   GitHub account, using the switcher's compact visual style. Display available
   repositories with owner/name and visibility. The first release connects one
   repository per attempt.
3. If GitHub already grants access, selecting a repository enables **Connect
   repository**. Otherwise show **Grant access on GitHub**. Keep that action
   available below the picker for repositories missing from the list.
4. For new installations, send the operator to the GitHub App installation page.
   For an existing installation, use its installation settings URL to adjust
   repository access. GitHub handles installation permission and approval.
5. On return, validate the connection attempt, refresh inventory, and confirm
   which repository the operator wants to connect. An installation can grant
   access to multiple repositories, so returning is not itself consent to connect
   all of them. For an update that does not return automatically, provide
   **I've updated access — refresh repositories** on the connection page.
6. Connect atomically and open the policy library immediately. Show a compact
   “Syncing repository…” status while initial labels and open items load. Allow
   authoring during sync; testing explains that items are loading. Avoid fake
   percentage progress and a blocking setup wizard.
7. When initial data is ready, replace sync status with the normal repository
   status. The existing main empty state prompts **Create policy**. A published
   policy alone does not apply labels; rules remain the next deliberate step.

## Additional repository

- Add **Connect repository…** as a persistent footer action in the repository
  switcher, outside its filtered results.
- Open the same `/repositories/connect` page. Preserve the previous repository
  route for Cancel and use the existing unsaved-edit navigation guard.
- Show connected repositories as disabled “Connected” rows, with an Open link.
  Show retained, disconnected repositories as “Reconnect.”
- After connection, switch to the new repository's policy library. Keep the
  previous repositories and their configuration unchanged.
- Reconnection restores retained policies and rules in a paused state. Explain
  that saved automation exists and require an explicit resume after reviewing
  it. Reuse the pause/resume behavior rather than silently activating old rules.

## Disconnect

1. Add a Connection section in repository Settings with access status, a link to
   GitHub installation settings, and a separate **Disconnect repository** action.
   Keep Pause/Resume distinct.
2. Open a small confirmation dialog naming `owner/repository`. Explain:
   “Janitor will stop syncing and applying rules for this repository. Existing
   GitHub labels stay as they are. Policies, rules, and history are kept for
   reconnection.” Show the number of enabled rules affected.
3. Confirm once with **Disconnect repository**. Preserve the current unsaved-edit
   guard before reaching Settings; do not introduce another typed-name prompt.
4. The server disconnects and disables the repository atomically, records who
   did it, and invalidates scheduled work. Workers must recheck eligibility before
   external writes. A GitHub request already sent may finish; do not claim it can
   be recalled. Coordinate active writes so successful completion is not shown
   while locally tracked mutations are still starting or running.
5. Remove the repository from the connected switcher list and clear stale
   last-repository state. Open another connected repository if one exists;
   otherwise return to the first-repository welcome state. Show a confirmation
   with **Reconnect**.
6. A direct link to a disconnected repository shows a disconnected state with
   Reconnect or Choose repository actions, not a generic missing-document error.

GitHub access may remain after local disconnection. Offer **Manage GitHub access**
as a separate link, with wording that permission removal affects the GitHub App.
Do not uninstall an installation to disconnect one repository: that may affect
other repositories. For an all-repositories installation, individual access
removal requires adjusting repository selection in GitHub settings.

## Routes and API

| Route                                  | Purpose                                                         |
| -------------------------------------- | --------------------------------------------------------------- |
| `/`                                    | Last connected repository, chooser, or first-repository welcome |
| `/repositories/connect`                | Shared connection and reconnection page                         |
| `/repositories/connect/return`         | GitHub return verification and inventory refresh                |
| `/repositories/:repositoryId/settings` | Connection details, pause/resume, disconnect                    |

Match the reserved `connect` routes before repository ID routes in Foldkit.
Keep transient picker/search/progress state in a Foldkit submodel; use Commands
for API work and the existing navigation guard for departures. Do not build a
generic onboarding engine or persist a step number.

Proposed authenticated endpoints under `/api/v1`:

- `GET /repository-connections/available`: discovered candidates, access and
  connection state, account identity, and permitted installation settings URLs.
- `POST /repository-connections/github`: start an installation/update attempt
  with short-lived, session-bound state and an allowlisted return destination.
- `POST /repository-connections/refresh`: coalesced inventory refresh for an
  authorized installation. The UI observes refreshed candidates with bounded
  polling and a retry state.
- `PUT /repositories/:repositoryId/connection`: idempotently connect or reconnect.
- `DELETE /repositories/:repositoryId/connection`: idempotently disconnect without
  deleting retained data.

Verify installation identity and fresh GitHub access server-side before enabling
work. Callback/query parameters are hints only. Refresh, webhook, and manual
refresh arrivals must converge through the existing inventory synchronization.
Do not require the webhook to arrive before the callback can finish.

## Minimal backend changes

1. Add explicit local connection membership, separate from `enabled` and GitHub
   access. Use a timestamp or small membership record, not multiple overlapping
   status enums. Derive Connecting/Syncing/Ready/Paused/Access lost display states.
2. Backfill existing managed repositories deliberately. An `enabled = false`
   repository may be paused, so do not equate it with never connected. Preserve
   existing configured/previously managed repositories; review ambiguous inventory
   rows during migration.
3. Wrap the existing planner enable/disable behavior in a connection service with
   transactional state changes, audit entries, idempotency, and access checks.
4. Filter workspace lists to connected repositories. Keep inventory candidates
   available to the connect page. Gate sync scheduling, tests that call external
   services, and label writes on connection/access/enablement as appropriate.
5. Review queued and in-flight workers for disconnect races and stale callbacks.
   Discovery and later webhooks must never undo an explicit local disconnection.
6. Preserve configuration when GitHub access is suspended or removed. Show
   “Access lost” with Repair access and Disconnect actions. Re-granting access
   must not reconnect a repository that an operator explicitly disconnected.

## Recovery states

Handle GitHub cancellation, organization approval pending, no eligible
repositories, inaccessible/private repositories, suspended installations,
revoked access during connection, delayed inventory, sync failures, and expired
return attempts explicitly. Give each a next action. A failed inventory request
must not make a connected repository disappear. Failed initial sync leaves the
connection visible with Retry, not an apparent successful Ready state.

## Delivery and validation

1. Implement connection membership, service, authenticated endpoints, and migration.
2. Build the shared connection page and first-repository state; add the switcher
   footer entry and resumable GitHub handoff.
3. Add bootstrap feedback, access-repair states, and paused reconnection.
4. Add Settings disconnect, worker coordination, and route fallback.

Test first connection, additional connection, reconnect without automatic old-rule
activation, duplicate submissions, browser reload/back/cancel, callback/webhook
order, denied/expired attempts, access loss, failed sync, disconnect during queued
and active work, and disconnecting the last repository. Verify keyboard focus,
screen-reader progress, mobile layout, and unsaved-edit guards. Confirm connection
alone performs no label mutations and retains AI consent disabled for new repos.

## GitHub references

- [Installation management endpoints](https://docs.github.com/en/rest/apps/installations)
  expose installation identity, repository selection, and installation settings URL.
- [GitHub App setup settings](https://github.com/github/docs/blob/main/content/apps/sharing-github-apps/registering-a-github-app-using-url-parameters.md)
  describe setup URL and setup-on-update behavior.
- [Installation management API constraints](https://github.blog/changelog/2023-06-09-updates-to-github-app-installation-management-apis/)
  explain the all-repositories restriction on individual repository removal.
