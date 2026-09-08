# Repository live updates

Replace the browser's recurring configuration, test-candidate, consent, activity, and sync reads with change notifications. Keep existing HTTP endpoints for data and mutations.

## Connection

Use one WebSocket per browser tab for the selected repository, routed through the API Worker to a dedicated repository Durable Object. Use Cloudflare's WebSocket Hibernation API. Do not put a polling loop in the object or attach browser sockets to the cluster's internal execution objects.

Validate the Access identity, repository access, and browser Origin before upgrading. Bind the authorized repository and session expiry to the socket attachment. Bound connection lifetime to the authenticated session, and close connections on repository disconnection or authorization expiry. A failed authorization must not enter a reconnect loop.

## Notifications

Send small messages identifying what changed: repository configuration, activity, sync status, test candidates, AI consent, or a particular rule test. Coalesce bursts. Refresh only the visible data affected by the message; mark inactive screens stale until opened. Preserve the Activity journal's existing new-entry buffer.

Publish notifications after successful database commits. Notifications are hints, never the authoritative state. For reliable delivery across a process crash after commit, use a transactional outbox and the existing durable dispatch machinery. Coalesce records per repository and topic, and avoid emitting a notification for unchanged sync status. Do not introduce a second high-frequency scheduler.

## Recovery

Start the socket alongside the initial HTTP reads. On every Ready message, refresh the active screen and sync status to cover the connection gap. Buffer invalidations during reads and merge their topics before fetching again. Notifications carry a database revision; HTTP responses remain authoritative. Reconnect with exponential backoff and jitter, show disconnected state, and offer manual retry. Use a slow, visible-tab-only HTTP fallback while sockets are unavailable. Reconnect when the tab becomes visible.

Implement socket lifetime and reconnect handling as a Foldkit subscription. Decode messages with schemas and dispatch ordinary Messages through update. Local mutations continue updating the initiating tab immediately.

## Cost and validation

Cloudflare counts the initial connection as a request. Durable Objects also bill internal requests and incoming messages; server-to-client WebSocket messages are not charged as requests. Hibernation avoids idle duration charges. This reduces browser polling traffic but is not a zero-cost transport.

Measure Worker requests per open tab, notification fanout, database reads, reconnects, and time from a committed change to the UI update. Verify multiple tabs, repository switching, expired sessions, deployments, lost notifications, hidden tabs, and event bursts. An idle connected tab should issue no periodic data fetches.

References: [Cloudflare pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) and [WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).

## Compatibility review of the installed adapters

Reviewed September 7, 2026 against the installed Alchemy 2.0.0-beta.75 and vendored `@effect/platform-cloudflare` 4.0.0-rc.110 at Effect commit `f4143802256d135864f15314fc37385e919999b1`.

The stack exposes the APIs needed for a dedicated hibernating liveness Durable Object:

- Alchemy `Workers/WebSocket.js` implements `upgrade()` with `DurableObjectState.acceptWebSocket`, rather than the non-hibernating WebSocket `accept()` API.
- `Workers/DurableObjectState.js` exposes `getWebSockets`, tags, automatic responses, and hibernatable event timeouts. Socket wrappers expose attachment serialization and restoration.
- `Workers/DurableObjectBridge.js` forwards message and close events through Effect. Each object activation reconstructs its instance with that object's state. Event scopes finish after handlers return; the bridge does not hold a socket-lifetime Effect open.
- Effect's installed `HttpServerResponse.toWeb` preserves a native Response stored as a raw body, including the WebSocket upgrade response.
- `AlchemyCloudflareCluster.make` registers four separate cluster object classes on the hosting Worker. It does not replace Alchemy's Durable Object registration API or prevent adding another class.
- The workflow runtime persists execution state and sets the durable-clock in-memory threshold to zero. Suspended work can resume after object reconstruction. This is workflow durability, not a browser WebSocket transport.

The cluster entity, workflow, queue, and singleton programs do not expose browser WebSocket handlers. Entity resources can deliberately hold an object awake through the entity keep-alive mechanism. The liveness object must therefore be its own class, with short handlers and attachment-backed session state. Do not attach sockets to a workflow, hold a cluster streaming RPC open, or start recurring timers to maintain a connection.

The installed Alchemy bridge explicitly forwards `webSocketMessage` and `webSocketClose`, but does not explicitly forward `webSocketError`. If custom error-event handling is required, add and test that adapter support before relying on it. This does not remove the existing hibernation APIs.

## Implementation and verification

`apps/cluster/src/LiveHub.ts` declares `RepositoryLive`, a separate Durable Object with short native hibernation handlers. It stores session expiry in socket attachments and schedules an alarm for the nearest expiry. Automatic ping/pong responses run without activating the object. The browser uses Effect's `Socket.makeWebSocket`, scoped writer, and `runString` through a Foldkit subscription in `apps/web/src/components/live.ts`. A socket-lifetime Effect on the server would prevent hibernation, so the server uses Alchemy's native wrappers instead.

Migration `0013_live_notifications.sql` adds transactional triggers and a coalescing outbox. Successful API mutations, completed sync runs, reconciliation, and rule-test transitions dispatch notifications. The existing one-minute cron retries pending rows. Delivery failures retain rows, and deletion checks the exact revision so it cannot erase a concurrent update. Sync notifications reach all connected repositories because the header shows a global sync summary. Notification dispatch has bounded timeouts.

The client preflights access once per connection attempt, stops automatic retries on explicit access denial, and limits socket lifetime to the earlier of Access expiry or one hour. Hidden tabs close their connection. Disconnected visible tabs use a 60-second fallback; connected tabs make no periodic data requests. Rule tests refresh on notifications, retry temporary HTTP read failures, and have a local four-minute deadline even if no completion notification arrives.

Verified locally on September 7, 2026:

- An isolated Alchemy stack using the same Durable Object code kept the same socket open across an 18-second idle period. Constructor activation IDs changed before a POST notification delivered a Changed frame, proving object reconstruction while the connection survived.
- The same integration check received automatic pong responses and closed a short-lived session with code 4001 when its attachment expiry elapsed.
- Chromium connected through the actual website, Vite proxy, API Worker, and repository object. During a 45-second idle window it made zero API fetches and received a pong.
- Changing a local repository setting delivered a Changed frame and refreshed the repository list and sync summary without fetching the activity table. The original setting was restored after the check.
- Database tests cover rollback, coalescing, failed delivery, concurrent revisions, and disconnected repository access. HTTP tests check origins and session expiry. Frontend tests cover fallback timing, repository fencing, invalidation buffering, and notification-driven rule-test reads.

Deploy through the normal production command so migration 0013 is applied and Alchemy registers the new Durable Object binding before the updated client is served. These checks establish local behavior; production request counts should be measured after that deployment.
