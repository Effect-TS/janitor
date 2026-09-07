# Dashboard mockups

Static HTML, no build. Open any file in a browser; the button in the corner
toggles dark mode. `mockup.css` mirrors the tokens in `apps/web/src/styles.css`
so anything here can be lifted into Foldkit views.

## Repository switcher studies

Isolated closed and open switchers, without the rest of the page. Each study
has theme switching, repository search, and selection. Open the HTML files
directly; no server or build is required.

| File                                                                         | Direction                                                                |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [7a-repository-switcher-compact.html](7a-repository-switcher-compact.html)   | Compact owner groups with rule and policy counts.                        |
| [7b-repository-switcher-activity.html](7b-repository-switcher-activity.html) | A quieter activity summary: items labeled in the last seven days.        |
| [7c-repository-switcher-labels.html](7c-repository-switcher-labels.html)     | Two managed-label previews per repository, with a remaining-label count. |

All closed controls contain only the repository icon, owner, name, and active
state. Active means Janitor is enabled; revision and synchronization details
are deliberately absent. Repositories, counts, and label previews are sample
data. Counts and label previews would need additional data when implemented.
Shared presentation and prototype behavior live in `repository-switcher.css`
and `repository-switcher.js`.

## What is wrong with the current dashboard

`apps/web/src/components/repositories.ts` renders everything for one repository
on a single page: a repository list rail, an inline panel slot, then Policies,
Rules and Reconciliations tables stacked with an AI consent block between them.

- **Repository selection is a page-level list**, so the rail spends 16rem on a
  handful of names and the rest of the page has no persistent context.
- **Editors push the tables down.** Opening a policy, a rule, or the bench
  inserts a panel above the tables, so the thing you are editing and the thing
  you are editing it against never sit side by side.
- **The policy editor shows no consequences.** Validation is a single line; the
  manifest (facts, tracks, references) and the bench live in separate panels.
- **Rules are a flat table.** Groups and priorities are just columns, so the
  exclusive-group semantics that decide which label wins are invisible.
- **Nothing shows what the system did.** Reconciliations render as ids and
  generations rather than label changes on numbered items.
- **Copy is generic.** "On no match: ensure-absent" reads as a wire value, not
  as an instruction to the maintainer.

## The mockups

Every mockup keeps the same header: brand, a **repository switcher** that sets
the context for the whole dashboard (`⌘K`), page tabs with counts, revision
status, sync, theme. Mockup 2 shows the switcher open.

| File                        | Page          | Idea                                                                                                                                                                                                                         |
| --------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `1-policy-workbench.html`   | Policy editor | Three panes: policy rail, editor with completion, inspector (manifest, track readiness, quick bench, bindings). Status bar carries draft/publish state.                                                                      |
| `2-policy-split-bench.html` | Policy editor | Editor left, full bench right as a table with an inline trace drawer. Segmented control switches the bench subject between draft, published, and whole configuration.                                                        |
| `3-rules-ledger.html`       | Rules         | Revision pipeline strip, rules grouped by exclusive group with drag priorities and a 7-day sparkline, inline edit row with plain-language explanation of the two settings, labels rail showing bound/unbound/missing labels. |
| `4-rules-board.html`        | Rules         | Each rule drawn as a pipeline (policy → add label · no match → remove/leave), recent decisions under the table, and a side sheet editor with radio explanations, live preview, and a conflict banner.                        |

## Decisions the mockups take

- Repository is global context, chosen in the header, not a sidebar list.
- Policies, Rules, and Activity are separate tabs. The current single page hides
  too much below the fold once a repository has more than a few policies.
- No modals for editing. Inline rows (mockup 3) or a side sheet (mockup 4) keep
  the table in view.
- Every save names the revision it creates, and the header shows whether that
  revision is active or waiting on a track.
- The bench is never more than one click from the editor, and the editor pages
  show a summary of the last run without opening it.

## Round 2: calmer workbench variants

Built on mockup 1 with more spacing and less chrome. `workbench.css` adds the
sidebar styles and larger control sizes.

| File                           | Navigation                                                    | Layout                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `5a-workbench-sidebar.html`    | Vertical sidebar with the repository switcher at the top      | Policy list, editor, and a sparse inspector (validation, tracks, last test as three numbers, used by, published).            |
| `5b-workbench-nested-nav.html` | Vertical sidebar with policies nested under the Policies item | Two panes only: editor and a column of cards (status, test, used by, history). No separate policy list.                      |
| `5c-workbench-focused.html`    | Top tabs                                                      | One centered column: editor, then a 2×2 grid of cards below it. Reads like a document page.                                  |
| `5d-workbench-rail-bench.html` | Icon rail                                                     | Policy list, editor above, bench below as a full-width table. Inspector information is folded into one line in the page bar. |

## Round 3: the rest of the app in the 5a style

| File                     | Screen                                                                                                                                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `6a-policy-bench.html`   | Bench opened from a policy. Table of open items with draft and published outcomes side by side, a "would" column, and a trace card plus facts card for the selected row.                                                                  |
| `6b-policy-history.html` | Version list on the left, a diff between versions on the right, with what the selected version read and which rules used it.                                                                                                              |
| `6c-rules.html`          | Same three panes as 5a: rule list grouped by exclusive group with enable switches, the selected rule as a form (label, policy, no-match choice, group, drag-to-order), and an inspector with policy, tracks, preview counts, and history. |
| `6d-activity.html`       | Day-grouped feed mixing label changes and configuration changes, with a status pill and a one-line reason under each item.                                                                                                                |
| `6e-home.html`           | Four stats, one attention banner, recent label changes, synchronization per track, AI toggle, and a needs-attention list.                                                                                                                 |

## The Tailwind port

`tw/` holds the chosen design (`5a-workbench-sidebar.html`) rewritten with
Tailwind v4 utilities, ready to move into Foldkit a component at a time. The
CSS-file mockups above stay as they are; they are the reference, not the
source.

| File                       | What it is                                                                                                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tw/policy-workbench.html` | The policy screen. Regions are separated by comments naming the Foldkit component each will become.                                                                               |
| `tw/theme.css`             | Tailwind entry. The token block is copied from `apps/web/src/styles.css`, plus the status colours (`ok`, `warn`, `info`) and the JSON syntax colours the app does not define yet. |
| `tw/policy-workbench.css`  | Compiled output, checked in so the page opens without a build step.                                                                                                               |
| `tw/build.mjs`             | Recompiles it: `node docs/mockups/tw/build.mjs`. There is no Tailwind CLI in the workspace, so this drives the compiler the Vite plugin uses.                                     |

Porting notes:

- The status and syntax colours are the only tokens the app is missing. Add
  them to `apps/web/src/styles.css` first, then delete them from `theme.css`.
- The editor markup is a stand-in for CodeMirror's DOM. Only the frame, the
  gutter, and the completion popup are worth porting; CodeMirror renders the
  lines.
- Repeated utility strings (the nav link, the policy row, the pill) are the
  seams. Each is one Foldkit view function.
- Label colours come from GitHub, so they stay inline styles rather than
  classes.

## Policy editor studies

Three compact variations on `5a-workbench-sidebar.html`, using the repository
switcher studies' neutral palette, small typography, and quiet selection states.
Open any file directly in a browser. The links across the top switch designs.

| File                                                 | Direction                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [8a-policy-document.html](8a-policy-document.html)   | Recommended. Editable name and description form a document heading above the program. |
| [8b-policy-compact.html](8b-policy-compact.html)     | A compact title bar with expandable policy details and an edge-to-edge editor.        |
| [8c-policy-inspector.html](8c-policy-inspector.html) | Name and description move into the right sidebar, leaving more room for the program.  |

Each keeps application navigation, searchable policies, a central editor, and a
right-hand test bench. Secondary dependency information is collapsed. Search,
selection, new drafts, name and description edits, JSON editing and formatting,
and light/dark mode work locally. Press `/` outside a field to search policies.

The needs-rebase policy has three sample test outcomes. Changing its program
clears the result; the prototype does not evaluate edited policies. Saving and
publishing only simulate state changes in memory. Reloading resets the mockup.
JSON syntax validation is real; domain validation is not implemented here.
Other navigation links lead to earlier mockups. Shared styles and interactions
live in `policy-editor-studies.css` and `policy-editor-studies.js`.

### Tighter document variant

[8d-policy-document-tight.html](8d-policy-document-tight.html) revises the document
layout with a shorter header. Name and description remain above the program;
target, published revision, and draft status move below the test bench in the
right sidebar. Rule usage stays in its existing sidebar disclosure. The
description uses one line initially and can be resized for longer notes.
The top navigation links back to the original document study for comparison.

### Sidebar actions

[8e-policy-sidebar-actions.html](8e-policy-sidebar-actions.html) removes the editor's
top toolbar. Publish and conditional Save draft move above the test bench; Delete
and Close use labeled, titled icon buttons. The document starts at its editable
title and description, followed by YAML. Search, edits, draft saving, publishing,
deletion confirmation, and theme switching work locally. Test results are illustrative.
Open the HTML file directly in a browser; it uses the shared study styles and
includes its own interactions.

## Labeling rule editor studies

Four rule editor directions use the policy screen's neutral palette, compact
navigation, quiet label colors, and conditional save controls. Open any file
directly in a browser, then use the tabs along the top to compare them.

| File                                           | Direction                                                                                                                           |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| [9a-rule-document.html](9a-rule-document.html) | Searchable rule list, a simple central form, and a right sidebar for status, validation, and testing. Closest to the policy editor. |
| [9b-rule-flow.html](9b-rule-flow.html)         | A vertical **When → Then → Otherwise** flow makes the condition and outcomes easier to read. Optional grouping stays collapsed.     |
| [9c-rule-table.html](9c-rule-table.html)       | The rules collection stays visible beside a scrollable editor. Better for reviewing and adjusting several rules.                    |
| [9d-rule-preview.html](9d-rule-preview.html)   | Configuration and a larger test preview sit side by side. Sample files and label changes make the rule's effect easier to inspect.  |

The heading uses the selected GitHub label. Rules do not gain an invented name,
description, YAML editor, or separate publishing lifecycle. The form reflects the
current model: label, published policy, no-match behavior, enabled state, and
optional exclusive group and priority. Lower priority values win within a group.

Search, rule selection, enabled/paused filters, new rules, conditional saving,
discarding changes, deletion confirmation, group fields, and light/dark mode work
locally. Press `/` outside a field to focus search. Choose a sample PR or issue
before testing; changing the form or sample clears the previous result. The initial
result demonstrates the presentation. Unsaved edits remain with each rule when
switching selections and reset when the page reloads.

Saving and testing are simulations using small local fixtures. No GitHub labels
or application data are changed. Policy links open the existing policy mockup.
The five HTML files share `rule-editor-studies.css` and `rule-editor-studies.js`.
They require no build step, external fonts, or network requests.

### Table variant revision

`9c-rule-table.html` now starts with a full-width table. It includes a rule type
column and a truncated behavior description, with the full text available on
hover. Current fixtures are Policy rules; the type column leaves room for future
AI rules. Search also matches behavior descriptions.

Click any part of a row, or focus it and press Enter or Space, to open a docked
configuration sheet. The table stays visible and usable beside it. Closing the
sheet restores the table's width and returns focus to the row; unsaved edits are
retained locally. Status, configuration, validation, and testing have separate
cards with labeled header bands. On narrow screens the sheet appears below the
table, without a backdrop or overlay.

### Table to flow variant

[9e-rule-table-flow.html](9e-rule-table-flow.html) opens with a rules table containing
label, type, behavior, and status. Choose **Edit rule** from a row's menu or click
**New rule** to replace the table with a When → Then → Otherwise flow editor.
Status, validation, and the test bench use separate sidebar cards.

Save returns to the table. Cancel discards changes or removes the new rule.
Back to rules retains unsaved work locally. The original table-and-sheet study
remains available as variant C. All five studies share the same local fixtures.

### Rule flow control layouts

These four interactive studies start with the same rules table. Use **New rule**
or a row menu's **Edit rule** action to open the editor. Each removes the validation
status, policy binding section, and duplicate close control. Back to rules stays
at the top left. Save appears for unsaved changes; Cancel discards them. Delete
requires confirmation and is available for existing rules. Invalid fields still
prevent saving, with a short error message in the form.

| Mockup                                                         | Control placement                                                                                                                                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [10a-rule-flow-header.html](10a-rule-flow-header.html)         | Enable switch at the far right of the Back to rules header. Save/cancel above the test bench and a full-width red Delete button at the bottom of the right sidebar. No status badge. |
| [10b-rule-flow-left-rail.html](10b-rule-flow-left-rail.html)   | Status and actions in a narrow left rail, with testing below the vertical flow.                                                                                                      |
| [10c-rule-flow-footer.html](10c-rule-flow-footer.html)         | Status and actions in a bottom bar, with testing on the right. The bar stays visible on desktop and follows the form on mobile.                                                      |
| [10d-rule-flow-horizontal.html](10d-rule-flow-horizontal.html) | Controls above three side-by-side flow steps, with a full-width test bench below. Steps stack on smaller screens.                                                                    |

Use the links at the top to compare the layouts. All interactions use local sample
data and reset on reload. These studies also share `rule-flow-controls.css`.

## AI labeling rule studies

Four interactive HTML variants explore editing an AI rule within the existing
labeling-rule layout. Open a file directly in a browser and use the top tabs to
compare the alternatives.

| Mockup                                                     | Direction                                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [11a-ai-prompt-document.html](11a-ai-prompt-document.html) | Recommended starting point. A large prompt document, compact evidence controls, and a quiet outcome summary. |
| [11b-ai-decision-flow.html](11b-ai-decision-flow.html)     | A numbered Read → Decide → Apply flow, closest to the current rule editor.                                   |
| [11c-ai-test-workspace.html](11c-ai-test-workspace.html)   | Instructions beside an evidence preview, with test controls and results in the right sidebar.                |
| [11d-ai-compact-form.html](11d-ai-compact-form.html)       | Aligned form rows make scope, instructions, evidence, and confidence easy to scan.                           |

Each uses a single GitHub label, a yes/no classifier prompt, selected evidence,
and minimum confidence. Negative, uncertain, and below-threshold results leave
existing labels unchanged. The form combines classifier and rule configuration
as a proposed editing experience; it does not change the application's current
policy-backed storage or add a separate publishing lifecycle.

Enable stays beside Back to rules. Save and Cancel appear in the right sidebar
only after edits. Delete sits directly below the test bench and asks for
confirmation. Repository AI access and exclusive grouping remain collapsed.

Try editing and canceling, saving, changing the target to Issues, selecting a
different test item, raising the confidence threshold, and switching themes.
The test fixtures demonstrate match, no-match, and unknown states. Scores and
explanations are fixed examples, not evaluations of edited prompts. Nothing is
sent to an AI provider or GitHub. All changes reset on reload.

The files share `ai-rule-studies.css`, `ai-rule-studies.js`, and `mockup.css`.
They work without a server, build step, or external assets. Desktop and mobile
layouts and the local interactions were checked in Chromium.

### Inline fact references

[11e-ai-inline-facts.html](11e-ai-inline-facts.html) revises the prompt document
with literal `{{fact:title}}` references instead of evidence checkboxes. Type
`{{` or choose **Insert fact**, then filter suggestions by name. Arrow keys
select an option; Enter or Tab inserts it; Escape dismisses the suggestions.
Available suggestions follow the Issues/Pull Requests target. Unknown,
incomplete, or incompatible references prevent saving, as do more than eight
unique facts. Referenced facts would determine the evidence automatically in
the proposed implementation.

The outcome summary below the prompt is removed. Minimum confidence now uses a
separate card with a larger readout, a filled track, and 70%, 80%, and 95%
presets. The test result uses “Match” instead of “Would add label.” The original
four layouts remain available for comparison. Autocomplete, target validation,
presets, cancel, and mobile overflow were checked in Chromium.

## Repository Overview

[12e-overview-empty.html](12e-overview-empty.html) is the revised direction: the
repository name, “Your repository is connected,” and a View rules link. Open the
HTML directly in a browser. No status panels, counters, or activity feed.

### Earlier Overview studies

The four initial dashboard layouts below were rejected and are retained only
for reference.

Four standalone HTML variants for the repository landing screen:

- [12a-overview-brief.html](12a-overview-brief.html): The brief. One column with labeling status, compact counts, and recent activity. Recommended starting point.
- [12b-overview-split.html](12b-overview-split.html): Activity first. Recent decisions on the left, with a narrow status and navigation rail on the right.
- [12c-overview-ledger.html](12c-overview-ledger.html): The ledger. A slim summary and a compact activity table for scanning many decisions.
- [12d-overview-rules.html](12d-overview-rules.html): Rules at a glance. Rule cards show labels, evaluator types, gates, and latest outcomes above recent activity.

Use the top preview controls to switch between enabled, needs-attention, paused,
and no-rules states, or toggle the color theme. Navigation links either open an
existing HTML study or a small explanation of the intended destination. The sync
button is also a local preview. All data is illustrative; no requests are sent to
Janitor, GitHub APIs, or an AI provider. Changes reset on reload.

These files share `repository-overview-studies.css`,
`repository-overview-studies.js`, and `mockup.css`. Open them directly in a browser;
no build or server is needed. Desktop and phone widths, all four states, and
preview controls were checked in Chromium.

## Activity screen studies

Four alternatives focus on labeling outcomes and the reason behind each decision.
Open any HTML file directly in your browser, then use the top links to compare.

| Mockup                                                     | Strategy                                                                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [13a-activity-journal.html](13a-activity-journal.html)     | A chronological journal. Read what changed, then expand an event for its reasoning.                                 |
| [13b-activity-ledger.html](13b-activity-ledger.html)       | A compact table with a persistent, non-overlay detail pane. Best for scanning and comparing decisions.              |
| [13c-activity-threads.html](13c-activity-threads.html)     | History grouped by issue or pull request. Shows how a label changed as descriptions and commits changed.            |
| [13d-activity-attention.html](13d-activity-attention.html) | The latest unresolved decisions first. Separates failed label writes and insufficient evidence from completed work. |

Try searching for `7908`, filtering to Issues, selecting Yesterday for an empty
state, and switching the theme. The table's subject buttons update its detail
pane. Journal events and subject histories expand inline. Attention first has
Needs attention and Handled queues; an older uncertain decision is resolved by a
newer successful evaluation of the same subject.

All events, explanations, timings, and confidence values are fictional examples,
including those associated with real GitHub numbers. No network requests, label
writes, retries, or AI calls occur. GitHub links open the actual site. View rule
links open an existing editor study rather than a live rule. The shared CSS and
JavaScript work from disk without a build or external assets.

These are UI proposals, not a claim that every field is already exposed by the
activity API. Implementation would need to join reconciliation and label-action
records with subject titles and decision diagnostics. Historical input excerpts
would also need an explicit retention strategy; the current test-inspection TTL
is not a durable activity archive.
