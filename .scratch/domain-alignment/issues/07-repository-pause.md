# 07: Pause repository automation and synchronization together

Status: ready-for-agent
Blocked by: None

## What to build

Provide a single repository-wide pause covering all current and future automation and synchronization, distinct from disabling an individual rule.

## Acceptance criteria

- [ ] Pause stops automation and synchronization while retaining configuration, stored facts, and GitHub labels.
- [ ] Repository webhook requests received while paused are acknowledged without storing payloads or events, updating facts, or scheduling automation.
- [ ] Pending or in-flight work cannot publish fact updates or apply label actions after the pause takes effect.
- [ ] Manual synchronization is unavailable while paused, with an actionable API response and matching UI behavior.
- [ ] Individual rule disablement remains separate and does not pause repository synchronization or other rules.
- [ ] Preserve installation-level access discovery needed to manage connections; prevent it from bypassing a repository pause.
- [ ] Update existing separate controls and persisted state deliberately, reporting ambiguous migration cases rather than guessing user intent.
- [ ] Verify ingress storage behavior and races with synchronization and label writes, not just displayed pause state.
