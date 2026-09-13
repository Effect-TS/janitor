# Ticket 04 implementation review

Baseline: `3774605` (the working tree before commit). Two independent reviewers examined the implementation: one against the repository's documented standards and Fowler's smell baseline, one against the ticket, the accepted specification's "Observation and lifecycle" section and the observation contracts decision.

## Standards

No documented-standard breaches. Judgement calls acted on: the Slack permalink helper is now shared (`Slack/HomeThread.ts`), the live-route expiry bound is shared (`Ingress/Live.ts`), the web read-failure decoding is shared (`lib/api.ts`), the unused domain topic constant and the wire usage buckets were removed, the platform label switch was extracted, and `activity_key`/`count` were renamed. Left as is: the dashboard navigation says "Sessions" rather than the glossary's "Janitor dashboard"; the projection table now has more than one writer (input acceptance and terminal admission rejection mark the session working or failed before the runner's events arrive), which the spec's "accepted work is being admitted" state requires. Glossary gaps to record with `domain-modeling`: execution states, meaningful activity, projection freshness, invalidation intent.

## Spec

Findings and outcomes:

1. P1: a terminally rejected admission left the session working with "input pending" indefinitely. The rejection now marks the projection failed with the rejection reason; a later admission returns it to working. Regression asserted in the handoff test.
2. P2: read failures updated only the catch-up obligation and never invalidated, while the projection's heartbeat did. The catch-up obligation's last read and error now notify; the heartbeat column no longer does.
3. P2: an invalidation refresh re-read only the first page. A refresh now re-reads as many rows as are on screen (server cap 100).
4. P2: an old rejected input's error stayed on idle sessions with newer work. Only the latest accepted input's rejection is shown.
5. P2: no browser test for reconnect or fallback refresh. Added, with page preservation and an unrelated-topic check.
6. P3: platform recovery status in detail belonged to ticket 10 and was removed; input counts stay as concise activity; the misleading ordering index was dropped from the migration.

Verified correct by the reviewer: keyset ordering and pagination, usage replacement under cursor protection, unavailable versus normalized zero, membership recheck at the subscription boundary with revocation closing sockets, HTTP reads behind membership, and removal flushing invalidations.

## Validation

- `vp check` passed with warnings and no errors.
- The full suite passed after the fixes; the runner-backed suites stay skipped because the runner's isolated dependencies are not installed.
- No live Slack, GitHub, runner or deployment was exercised.

Standards: zero breaches, smells addressed where concrete. Spec: six findings resolved, highest severity P1; zero outstanding.
