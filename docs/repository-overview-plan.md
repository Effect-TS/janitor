# Repository Overview

Make Overview the default repository landing page. Its job is to answer three
questions: is labeling enabled, has it run, and does anything need attention?
Keep configuration and detailed history on their existing screens.

## Layout

Preserve the current application shell, repository switcher, typography, borders,
and spacing. Add Overview with a house icon before Policies in the sidebar.
Use a single content column with a compact summary row; no charts, secondary
sidebar, duplicate sync toolbar, or large welcome banner.

1. **Header.** Overview, with a small link to the repository on GitHub. The existing
   switcher already identifies the repository, so avoid repeating a large title.
2. **Labeling summary.** One status sentence, such as “Labeling enabled · 4 enabled
   rules,” and “Last automatic evaluation 12 minutes ago.” Show “Not evaluated yet”
   when appropriate. Enabled describes configuration, not successful execution.
   Include a compact Rules link and a secondary published-policy count linking
   to Policies. Exclude internally owned AI policies from that count.
3. **Needs attention, when relevant.** Show actionable rows above activity, each
   with a short explanation and one next step. Hide this section when empty.
4. **Recent activity.** The latest five automatic evaluations, newest first, with
   the issue/PR number and title, the result, and relative time. Link the item to
   GitHub and provide “View all activity” to open Activity. Show added/removed
   label badges when an actual edit was confirmed. Keep reasons concise and link
   relevant rules to their editors where useful.

On narrow screens, wrap the summary and stack activity details. Use text and
icons alongside color, accessible link names, and absolute timestamps in tooltips.
Keep stale data visible during polling; avoid a full-page loading flash.

## Status and empty-state copy

- No rules: “Create a rule to start labeling issues and pull requests,” with
  Create rule as the primary action. Policies can remain an ordinary navigation
  link; AI rules do not require creating a reusable policy first.
- All rules disabled: “Labeling paused · all rules are disabled,” linking to Rules.
- Repository automation disabled: “Labeling paused for this repository,” linking
  to Settings. Do not confuse this with sync being paused.
- Enabled rules, no automatic evaluation: “Ready for the next repository update.”
  Explain that saved rules currently run when an item is refreshed. Do not claim
  that evaluation is queued unless a job actually exists.
- No activity yet: a small in-place empty state, not a second onboarding banner.
- Failed summary request: an inline retry state. Never render missing data as
  zero activity or a healthy status.

Useful attention rows include lost repository access, missing label-write
permission, enabled rules referencing unavailable labels, enabled AI rules with
AI access disabled/provider unavailable, and the latest unresolved apply failure.
Only show an issue when supported by current data. Order access/write blockers
before rule-specific issues and informational notices. Do not leave historical,
resolved failures displayed as current problems.

Sync progress stays on the existing global sync control. Overview should only
mention sync when missing or stale evidence explains why labeling cannot proceed.

## Accurate activity reporting

The current action table uses `applied` both for confirmed writes and “already in
the desired state.” Preserve that distinction explicitly before displaying
“Label added” or “Label removed.” Add an optional structured action result, such
as `changed` or `already-correct`, while retaining the existing lifecycle status.
New writes record it at the point the GitHub response is handled. For old rows,
classify the known no-op detail conservatively; otherwise display “Processed”
when the record cannot prove that GitHub changed.

Use outcomes such as “Added bug,” “Labels already correct,” “No matching rules,”
“Skipped: gate did not match,” or “Could not update labels.” Group the display by
reconciliation, not by provider attempt. Manual test-bench runs must not count as
automatic activity or edits. Avoid daily totals in the first version: the recent
list and last-evaluated timestamp provide the useful evidence without a metrics
subsystem.

## Routing

- Render Overview at the existing `/repositories/:repositoryId` route, which
  currently leads to Policies. No new `/overview` alias is necessary.
- Opening `/` with a remembered accessible repository lands on its Overview.
- Selecting a repository from the switcher opens that repository's Overview.
- Preserve explicit Policies, Rules, Activity, Settings, and editor deep links,
  including browser Back/Forward and current unsaved-change protection.
- Preserve the repository chooser and connection onboarding when there is no
  selected or connected repository. Disconnected repository URLs keep their
  existing reconnect flow.

## API and implementation

Extend the existing labeling overview service with one repository-scoped,
read-only summary response. Keep the current repository-list endpoint small.
Return automation state, enabled/total rule counts, published policy count, last
completed automatic evaluation, typed attention items, and five recent activity
records with item titles and label names/colors. Apply the existing Access and
repository access checks.

Use indexed, bounded database queries and reuse stored configurations,
reconciliations, and label actions. Do not fetch GitHub or invoke AI while loading
or polling Overview. Persist the installed GitHub permission set through the
existing installation inventory refresh and permission-accepted webhook flow.
Use that saved state for the permission warning; unknown permissions must be
reported as unverified, not denied. No broader GitHub permissions are required
for the Overview itself.

Implement the screen as a Foldkit section using existing state, command, routing,
and polling conventions. Fetch its summary while Overview is selected, reuse the
existing polling cadence, and reject responses from an earlier repository or
request generation. Navigation away stops Overview polling.

## Delivery and validation

1. Add accurate action results and the summary API, with regression coverage for
   no-op actions, real writes, failures, empty repositories, and access isolation.
2. Add Overview navigation, default landing behavior, compact summary, attention
   rows, and recent activity using existing UI components.
3. Verify repository switching, deep links, browser history, unsaved edits,
   loading/error states, and small-screen layout. Test that rule counts and
   activity do not imply GitHub edits when none happened.
4. Run dependency checks, `vp check`, `vp test`, frontend build, and Worker bundle
   validation. Inspect a repository with existing activity and one without rules.

Automatic reevaluation after rule changes is a separate behavior fix. Overview
must describe today's behavior truthfully and can reflect queued work when that
scheduling is implemented. Do not add a “Run all rules” control as part of this
screen: it would introduce a separate operational workflow and potentially paid
AI calls.
