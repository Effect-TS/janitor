# Platform recovery validation

Ticket: [10-platform-recovery](issues/10-platform-recovery.md).

The implementation uses App JWT authentication for retained GitHub delivery listings. It stores opaque next-page URLs, exact decimal attempt IDs, separate delivery GUIDs, and pending payload work in PostgreSQL. Summary filters exclude unrelated event types and repositories before fetching payloads. Each scan traverses the available window, without a fixture event-count cutoff. Slack scans known threads after their initiating boundary and retains a five-minute overlap after successful scans.

Both scanners persist due times and lease ownership. A stale worker cannot commit over its successor. Slack delivery commits output state, warnings, and channel retry deadlines together. Uncertain sends still require positive marker, author, and thread evidence. Pending progress uses the same Unicode chunk bound as substantive replies.

## Local evidence

`PlatformRecovery.test.ts` exercises PostgreSQL with simulated platform responses. It covers exact attempt IDs, opaque pagination, redelivery GUID deduplication, summary filtering, Retry-After, expired payloads, incomplete recovery status, Slack overlap, preserved rejection, and initial-context exclusion. Its HTTP-adapter case uses real request construction and JSON decoding with a simulated GitHub server response. Rebuilt service layers use the persisted cursor and deadline.

`Slack/Delivery.test.ts` covers retained substantive/error output after simulated removal and service restart, independent delivery warnings, stable output IDs and destination, uncertain-send reconciliation, ordered output, coalesced progress, throttling and valid Unicode splitting. This is simulated membership evidence.

Repository checks and the full suite will be recorded after review.

## Live evidence

`Slack/Recovery.live.test.ts` is opt-in. It uses the production Slack transport and delivery services with a temporary PostgreSQL database and synthetic runner events. A participant removes and reinvites the installed bot in the existing private `janitor-test` channel. The test checks retained output IDs, delivery warnings, restored delivery to the same thread, and marker readback. It creates one root and two replies and deletes known created messages afterward. It advances only the fixture database's denial deadline after reinvite.

The live check is pending and will run last. It does not exercise a deployed Janitor worker, browser dashboard, real runner execution, or GitHub recovery against live retained history. No live bot-removal evidence is claimed until its result is recorded.

## Dependency and recovery limits

Ticket 04's paginated dashboard and subscriptions are not implemented in the starting tree. This change exposes recovery health and independent Slack delivery warnings through `AgentSessions.view`; browser visibility remains dependent on ticket 04. Existing feedback rows expose incomplete hydration independently.

Expired GitHub delivery history, deleted uncaptured Slack text, edited originals that were never captured, and never-received start mentions cannot be reconstructed. A missing publication marker does not establish a failed send and never authorizes reposting.

Platform contracts were checked against [GitHub App webhook deliveries](https://docs.github.com/en/rest/apps/webhooks), [GitHub retained delivery history](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/viewing-webhook-deliveries), [Slack message limits](https://docs.slack.dev/reference/methods/chat.postMessage/), and [Slack thread pagination](https://docs.slack.dev/reference/methods/conversations.replies/). The renderer emits plain text with a conservative 3,900-byte chunk bound and no blocks. Slack Retry-After handling remains necessary even for internal apps.
