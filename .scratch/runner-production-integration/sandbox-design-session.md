# Sandbox design interview

This records the renewed sandbox design discussion. It does not authorize implementation of an unfinished design. Evidence is in [sandbox research](sandbox-coordinator-research.md). Earlier implementation plans describe historical directions and do not override these decisions.

## Agreed constraints

- Restore Linux sandbox execution and keep deployment in the project's Alchemy stack.
- Preserve completed turns and accepted inputs across container loss. An interrupted turn may lose unfinished workspace changes and report interruption. Reconcile uncertain external writes before retrying them.
- Treat repository scripts as untrusted. Keep broad GitHub and model credentials outside the container and authorize scoped operations.
- Target default PR checks at three minutes. Full local stack simulation is optional. No integration check is required for now, including a deployed integration gate. The time budget has not been demonstrated.
- Consolidate coordination and sandbox ownership in one Durable Object. OpenCode runs inside that DO, with conversation state in DO SQLite and filesystem/process operations delegated to the Linux sandbox through focused Effect services.
- After interruption, restore the last completed turn's workspace, report the interruption, and wait for an explicit teammate retry. Do not automatically restart the interrupted model turn. Preserve its accepted input and reconcile uncertain external effects before retrying.
- Acknowledge accepted input and provide progress promptly. Report final success only after a consistent recovery point is saved. Retry failed saving without rerunning the model; if saving remains unsuccessful, report that work finished but could not be safely saved.
- Keep the container awake during work and saving. Stop it after five minutes of inactivity; keep conversation state in the DO and restore workspace state on the next turn.
- Make a clean transition with fresh sessions. The user authorizes removal of all existing Janitor sessions at cutover, including their conversation/workspace/checkpoint state. Historical session preservation and migration are not requirements. This is cutover scope, not an instruction to delete live state during the interview. Do not extend this to deleting published GitHub work or unrelated application records.
- Give each agent session its own sandbox-owning DO and isolated checkout. Sessions in separate threads do not share mutable files, even for the same repository. Process inputs sequentially within a session.
- Pause queued inputs after an interrupted turn until a teammate explicitly retries or skips the interrupted input. Do not run dependent inputs against restored state without that decision.
- Retain the latest confirmed workspace recovery point for the session's lifetime. Keep its predecessor until the replacement is safely committed, then delete it. Preserve unpublished source changes; rebuild disposable dependency caches. Session deletion removes its backups.
- Publication goes through a dedicated DO-controlled tool that checks repository authority and reconciles pushes/PR operations. Shell commands may edit, test and commit locally, but receive no GitHub write credentials.
- Background processes may run during a turn, but must stop before its recovery point is saved. Persistent preview servers are outside the initial scope.
- After the initial clean transition, deployments retain sessions and accepted inputs but may interrupt active turns. Affected sessions wait for explicit retry or skip. Do not build a deployment drain protocol for this iteration. Storage changes still must preserve the retained state; permission to interrupt is not permission to discard it.

## Direction under discussion

Cloudflare supports application logic in container-backed DOs. Use the SDK scheduler without overriding its alarm handler. Durable recovery obligations need explicit rescheduling; a thrown scheduled callback is not a retry guarantee. Existing sessions will be removed at cutover; identify and retire their execution resources without allowing delayed deliveries to resurrect them.

## Final interview decisions

- Retry and Skip buttons appear on the Slack interruption message for authorized session participants. Actions identify the interrupted input/attempt and are deduplicated; the dashboard remains an observation view.
- Send one acknowledgement after durable acceptance, update it with progress stages, and send the final answer separately. Do not post raw command output or intermediate model commentary.
- Default command timeout is ten minutes; default turn timeout is thirty minutes. Both are configurable. Command timeout is a tool error; overall timeout interrupts the turn and requires Retry or Skip. Saving has a separate bounded retry allowance.

Q1–Q17 are answered. The consolidated spec awaits confirmation of shared understanding before implementation.

## Existing behavior to replace

The old maintenance barrier/hold model assumes deployment draining and native automatic execution resumption. The new deployment policy allows interrupted turns and requires explicit teammate recovery. Retire runner-specific drain machinery as part of implementation; do not leave two conflicting recovery policies. Existing glossary entries describe the old implementation until that retirement is specified.

Record settled architecture in ADRs as decisions crystallize; do not treat options as accepted.
