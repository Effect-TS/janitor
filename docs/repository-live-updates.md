# Repository live updates

Replace the browser's recurring configuration, test-candidate, consent, activity, and sync reads with change notifications. Keep existing HTTP endpoints for data and mutations.

## Connection

Use one WebSocket per browser tab for the selected repository, routed through the API Worker to a dedicated repository Durable Object. Use Cloudflare's WebSocket Hibernation API. Do not put a polling loop in the object or attach browser sockets to the cluster's internal execution objects.

Validate the Access identity, repository access, and browser Origin before upgrading. Bind the authorized repository and session expiry to the socket attachment. Bound connection lifetime to the authenticated session, and close connections on repository disconnection or authorization expiry. A failed authorization must not enter a reconnect loop.

## Notifications

Send small messages identifying what changed: repository configuration, activity, sync status, test candidates, AI consent, or a particular rule test. Coalesce bursts. Refresh only the visible data affected by the message; mark inactive screens stale until opened. Preserve the Activity journal's existing new-entry buffer.

Publish notifications after successful database commits. Notifications are hints, never the authoritative state. For reliable delivery across a process crash after commit, use a transactional outbox and the existing durable dispatch machinery. Coalesce records per repository and topic, and avoid emitting a notification for unchanged sync status. Do not introduce a second high-frequency scheduler.

## Recovery

Establish the socket before the initial HTTP snapshot, buffering invalidations during that read. Include a monotonic repository revision in notifications. After reconnecting, refresh the active screen and sync status to cover missed events, including deployments and hibernation. Use exponential backoff with jitter; show disconnected state and offer manual retry. Use a slow, visible-tab-only HTTP fallback while sockets are unavailable. Resume or reconnect when the tab becomes visible.

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

This review verifies source-level compatibility. Before replacing browser polling, run an integration check through the actual Alchemy bridge: accept a socket, persist its attachment, let the object become idle, verify instance reconstruction on a later message while the client stays connected, and broadcast through a separate request. Check automatic ping handling, close/error behavior, and that no timer, unfinished request, database connection, or background fiber keeps the liveness object active. A successful echo alone does not demonstrate hibernation.
