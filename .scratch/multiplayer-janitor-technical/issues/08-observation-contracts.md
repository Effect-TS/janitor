# Decide dashboard and usage data contracts

Type: grilling
Labels: wayfinder:grilling
Status: resolved
Parent: ../map.md
Blocked by: 04, 06, 07

## Comments

### First discussion round, accepted with narrower usage scope

Carry forward the accepted compact session list/detail, working sessions first, team-wide observation, session input/output token totals and selected-period team totals. No conversation viewer, detailed execution logs, money, budgets, or session-control commands are being added.

A bounded read-only investigation is checking existing application read models/live updates and the pinned harness usage fields before choosing projection mechanics and token normalization.

Proposed decisions:

1. Distinguish working, idle, blocked, and failed execution states, with an independent delivery warning. Finishing a turn returns the ongoing session to idle; it does not mark the session permanently complete. A Slack delivery problem can coexist with successful agent work. Show the concrete reason for a blocked or failed state.
2. Keep session totals over the session lifetime. Team usage defaults to the last seven days with explicit date-range selection using UTC boundaries, counting usage when reported by the harness rather than by session creation time. Label the time basis clearly so teammates see the same totals.

The user accepted the state recommendation and session totals, but explicitly deferred team totals. The proposed team aggregation, date selection, and UTC period rules are not MVP requirements. This supersedes selected-period team totals in the earlier product dashboard decision. Team-wide visibility of individual sessions remains unchanged.

### Source findings and remaining usage presentation decision

Read-only inspection found the existing `LiveHub.ts` and `LiveUpdates.ts` use durable notification rows and WebSocket invalidations followed by HTTP read refreshes. The web client refreshes on reconnect and has a fallback timer. Extend this pattern to session read models rather than inventing a durable browser event stream. Browser Access expiry remains separate from persistent platform-account authorization.

At the pinned OpenCode source, `packages/schema/src/token-usage.ts` and `packages/core/src/session/usage.ts` define five disjoint normalized buckets: noncached input, visible output, reasoning, cache read, and cache write. Session `UsageUpdated` events contain cumulative values; replace projected totals rather than summing snapshots. The normalizer maps missing/invalid values to zero, so the projection cannot infer that a zero was explicitly reported by a provider. The local probe verified persistence of fake input usage, not real-provider accounting completeness.

The user accepted retaining all five source buckets and displaying two session totals: input includes noncached input plus cache read/write, and output includes visible output plus reasoning. Label these as recorded usage, explain the grouping briefly, and state that interrupted or unreported usage may be absent. No provider billing reconciliation, estimates, date filters, or team aggregation. More detailed presentation can be added later.

## Question

Which read models and application contracts serve the accepted session dashboard and token totals?

Define session list/detail fields, state and latest-activity semantics, related links, ordering, period filtering, and input/output token accounting, including retries and missing provider usage. Decide update delivery and access enforcement using the existing application where appropriate. Link to authoritative state owners rather than creating competing session histories. Preserve team-wide observation and the compact dashboard; no conversation viewer, monetary estimate, or detailed log viewer is part of this contract.

## Answer

### Read models and access

Janitor serves a paginated team-wide session list and compact session detail from durable projections. Both expose session ID, short title, associated repository when known, home-thread link, associated PR link when present, execution state and reason, latest activity time, recorded input/output totals, and any delivery warning. Detail adds concise current activity or latest error and projection freshness. Do not expose raw commands, execution logs, or conversation history through these reads.

Janitor owns session identity and associations; the runner owns conversation, execution facts, and usage. Delivery records supply delivery health. Build one read projection from those owners rather than maintaining an independent conversation or inferring execution state from an open connection. Unresolved repository selection has a nullable repository and a concrete waiting reason.

Browser reads and live subscriptions require valid Access authentication and an active Janitor teammate. Admins and members see the same session information independent of Slack channel membership. Private thread links do not grant Slack access. Browser authentication expiry does not revoke linked-account agent usage. A removed teammate cannot continue authorized observation through a previously opened subscription; enforce Janitor status on reads and subscription lifecycle.

### State, activity, and ordering

- Working: accepted work is being admitted, executed, or automatically recovered. The concise activity distinguishes queued, executing, and recovering work where known. Durable work state, not mere absence or presence of a process, determines this status.
- Idle: no accepted work is pending or running and no current failure or blocking condition prevents progress. A successful turn returns an ongoing session to idle; it does not permanently complete the session.
- Blocked: progress requires missing context, restored repository readiness, or resolution of an uncertain operation. Show the concrete reason and the relevant conversation link. No dashboard resume command is added.
- Failed: execution or admission has reached a terminal failure. Show the latest actionable error until later work or recovery changes the state. A historical failed turn does not override newer successful work.

Delivery warnings are independent: work may finish successfully while its Slack reply is pending. Known loss of home-thread access alone does not turn execution into failure. An uncertain external operation that blocks dependent work does affect execution state under the recovery contract. Projection staleness is also independent; a stale read does not prove a runner failure.

Order working sessions first, then other sessions by latest meaningful activity descending, with stable session ID as a tie-breaker. Use stable pagination over those keys and refresh the visible list when invalidated. Meaningful activity includes accepted input and agent work/result changes; heartbeat, replay, usage-only updates, and delivery retry bookkeeping do not continuously reorder the list. Keep projection freshness separate from activity time.

Repository disconnection removes its session projections and usage along with the accepted deletion of session data. Reconnection starts fresh. Account disconnection or teammate removal preserves session visibility for remaining teammates, accepted contributions, and usage.

### Recorded token totals

Retain the five normalized OpenCode buckets in the projection. Display session-lifetime input as `input + cache.read + cache.write`, and output as `output + reasoning`. Include concise help text explaining cached input and reasoning inclusion. These are OpenCode-recorded usage, not a monetary estimate or a claim of billing completeness.

Project cumulative UsageUpdated snapshots by replacement, guarded by the durable source cursor; never sum cumulative snapshots. Apply the snapshot and advance the consumer cursor atomically. Replaying runner events or retrying a delivery must not increase totals. Separate actual model attempts count only as recorded by the harness, including harness-recorded compaction or failed-step usage; do not infer omitted usage from request counts or text length.

Before any usable snapshot arrives, represent totals as unavailable rather than fabricated zero. After normalization, a recorded zero cannot distinguish missing provider data from an explicitly reported zero. Retain a concise standing explanation that recorded totals may omit interrupted or unreported usage; do not invent a completeness flag from those normalized values. Missing usage does not prevent displaying otherwise known session state.

No team totals, time buckets, period filters, monetary estimates, per-person allocation, or cache/reasoning breakdown UI are required for this MVP. Keeping the original buckets permits a later breakdown without changing the current presentation.

### Updates and validation

Extend Janitor's existing durable notification and WebSocket invalidation pattern with session list/detail topics. Commit read-model changes and notification intent together, then let clients refresh HTTP reads. On initial connection, reconnect, and the existing fallback timer, refresh current reads. Browser notifications are not a durable event stream; losing an invalidation must not lose authoritative state. Preserve last known data with visible reconnecting/stale status when refreshing fails.

Validate cumulative usage replay and out-of-order rejection, cache/reasoning grouping, unavailable versus normalized-zero usage, turn completion returning to idle, working with a delivery warning, terminal versus historical failure, repository deletion, teammate removal, and a missed invalidation followed by refresh. The existing fake-model probe establishes persistence for its fixture, not real-provider accounting completeness. Production runner liveness remains governed by its separate verification gate.
