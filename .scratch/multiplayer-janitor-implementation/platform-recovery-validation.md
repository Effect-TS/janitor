# Platform recovery validation

Ticket: [10-platform-recovery](issues/10-platform-recovery.md).

The implementation uses App JWT authentication for retained GitHub delivery listings. It stores opaque next-page URLs, exact decimal attempt IDs, separate delivery GUIDs, and pending payload work in PostgreSQL. Summary filters exclude unrelated event types and repositories before fetching payloads. Each scan traverses the available window, without a fixture event-count cutoff. Slack scans known threads after their initiating boundary and retains a five-minute overlap after successful scans.

Both scanners persist due times and lease ownership. A stale worker cannot commit over its successor. Slack delivery commits output state, warnings, and channel retry deadlines together. Uncertain sends still require positive marker, author, and thread evidence. Pending progress uses the same Unicode chunk bound as substantive replies.

## Local evidence

`PlatformRecovery.test.ts` exercises PostgreSQL with simulated platform responses. It covers exact attempt IDs, opaque pagination, redelivery GUID deduplication, summary filtering, Retry-After, expired payloads, incomplete recovery status, Slack overlap, preserved rejection, and initial-context exclusion. Its HTTP-adapter case uses real request construction and JSON decoding with a simulated GitHub server response. Rebuilt service layers use the persisted cursor and deadline.

`Slack/Delivery.test.ts` covers retained substantive/error output after simulated removal and service restart, independent delivery warnings, stable output IDs and destination, uncertain-send reconciliation, ordered output, coalesced progress, throttling and valid Unicode splitting. This is simulated membership evidence.

`vp check --fix` passed with no errors and 476 warnings. The full `vp test` run passed 602 tests, with 6 skipped, across 108 passing test files and 3 skipped files. After that run, an expired-cursor regression failed as expected; the fix passed all 5 recovery service tests and a scoped `vp check` with no errors. The full suite was not repeated after that isolated fix.

The two-axis review used starting commit `f023941`. Standards found duplicated error conversion and dependent test setup; both were fixed and the follow-up found no remaining findings. The HTTP restart test also passed by itself. Spec review found no implementation defect, but recorded the dashboard prerequisite and pending live acceptance as partial requirements. A follow-up review of the expired-cursor fix found no additional issue.

## Live evidence

`Slack/Recovery.live.test.ts` is opt-in. It uses the production Slack transport and delivery services with a temporary PostgreSQL database and synthetic runner events. A participant removes and reinvites the installed bot in the existing private `janitor-test` channel. The test checks retained output IDs, delivery warnings, restored delivery to the same thread, and marker readback. It creates one root and two replies and deletes known created messages afterward. It advances only the fixture database's denial deadline after reinvite.

The live check passed on 2026-09-13 after the participant installed a replacement bot and invited it to private `janitor-test`. The participant then removed and reinvited that same bot during the test. Removal produced `channel_not_found`, retained both pending replies, and populated the independent session delivery warning. After reinvite, both original output IDs were sent to the original thread, author/thread/metadata markers matched on readback, and the warning cleared. The test deleted the root and both replies. See [live result](platform-recovery-live.json).

The earlier 2026-09-12 attempt stopped at `auth.test` with `account_inactive` before any writes. During the retry, the fixture's JSON POST to `conversations.info` returned `invalid_arguments`; using GET query parameters, as the production transport does, fixed that request. The corrected read then exposed missing channel membership, which the participant restored. The fixture fix passed scoped formatting, lint and type checks with no errors. The final live run passed one test in 315 seconds, including the participant waits.

This check does not exercise a deployed Janitor worker, browser dashboard, real runner execution, or GitHub recovery against live retained history.

## Dependency and recovery limits

Ticket 04's paginated dashboard and subscriptions are not implemented in the starting tree. This change exposes recovery health and independent Slack delivery warnings through `AgentSessions.view`; browser visibility remains dependent on ticket 04. Existing feedback rows expose incomplete hydration independently.

Expired GitHub delivery history, deleted uncaptured Slack text, edited originals that were never captured, and never-received start mentions cannot be reconstructed. A missing publication marker does not establish a failed send and never authorizes reposting.

Platform contracts were checked against [GitHub App webhook deliveries](https://docs.github.com/en/rest/apps/webhooks), [GitHub retained delivery history](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/viewing-webhook-deliveries), [Slack message limits](https://docs.slack.dev/reference/methods/chat.postMessage/), and [Slack thread pagination](https://docs.slack.dev/reference/methods/conversations.replies/). The renderer emits plain text with a conservative 3,900-byte chunk bound and no blocks. Slack Retry-After handling remains necessary even for internal apps.
