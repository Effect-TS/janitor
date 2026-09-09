# 07: Pause repository automation and synchronization together

Status: ready-for-agent
Blocked by: None

## What to build

Provide a single repository-wide pause covering all current and future automation and synchronization, distinct from disabling an individual rule.

## Acceptance criteria

- [x] Pause stops automation and synchronization while retaining configuration, stored facts, and GitHub labels.
- [x] Repository webhook requests received while paused are acknowledged without storing payloads or events, updating facts, or scheduling automation.
- [x] Pending or in-flight work cannot publish fact updates or apply label actions after the pause takes effect.
- [x] Manual synchronization is unavailable while paused, with an actionable API response and matching UI behavior.
- [x] Individual rule disablement remains separate and does not pause repository synchronization or other rules.
- [x] Preserve installation-level access discovery needed to manage connections; prevent it from bypassing a repository pause.
- [x] Update existing separate controls and persisted state deliberately, reporting ambiguous migration cases rather than guessing user intent.
- [x] Verify ingress storage behavior and races with synchronization and label writes, not just displayed pause state.

## Implementation notes

- Repository pause uses one writable flag, `enabled`. The former `sync_enabled` column is a generated compatibility value. Migration 0018 reports connected repositories with conflicting old settings and requires an operator choice before conversion.
- Signed repository webhooks check the repository under a transaction lock before queue or overflow storage. Receipt time is captured at handler entry, so a request waiting on body reading or signature verification cannot survive a pause/resume boundary. Installation discovery stays available.
- Pause invalidates pending sync and evaluation generations and retains configuration, stored facts and GitHub labels. Fact publication and external label writes serialize with pause using the repository lock before sync-target locks. Each subsequent sync HTTP attempt rechecks its run. Old webhook deliveries and cache responses cannot bypass the resume cutoff.
- Repository settings provide one pause/resume control. Manual sync uses a repository endpoint that returns an actionable 409 while paused. The old separate sync-settings endpoint directs callers to the connection endpoint.
- The user confirmed webhook HTTP, sync and label-write services, repository UI, and migration execution as test seams. Integration tests cover overflow storage, delayed signature verification, queued projection across pause/resume, late and active fact publication, queued and active label writes, and conflicting legacy flags.
- Review baseline: `2ee0198e36d136f3c143e25990f33fc25705419b`. Standards and Spec reviews have no remaining findings. Review fixes corrected retry lock order and webhook receipt timing.
- Validation: `vp check --fix` passed with warnings, and `vp build apps/web` passed. The full suite passed all 521 tests across 91 files using the local Podman socket and four workers.
