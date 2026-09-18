# Frontend liveness

Janitor uses WebSocket notifications to invalidate HTTP reads. The browser fetches
on page entry, explicit actions, relevant change notifications, and socket
reconnection. It does not fetch application data on a timer.

## Page audit

| Page or shared view                                  | Refresh trigger                                                                                                             |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Reviews and open run details                         | Repository `review` notifications                                                                                           |
| Activity                                             | Repository `activity` notifications                                                                                         |
| Policies and rules, including editors                | Repository `configuration`, `candidates`, and `consent` notifications                                                       |
| Running rule test                                    | Repository `test` notifications, one initial catch-up read, or manual Retry                                                 |
| Repository Settings                                  | Repository configuration/review notifications and `connections` notifications for inventory                                 |
| Connect and GitHub installation return               | Application `connections` notifications                                                                                     |
| Account, connected accounts, Team                    | Application `account` notifications                                                                                         |
| Repository switcher and unavailable repository views | Repository `repository`/`connections` notifications, or application `connections` when no accessible repository is selected |
| Sync status in the header                            | Repository `sync`/`repository`/`connections`, or application `connections` notifications                                    |
| Home                                                 | Redirects into the repository or connection flow                                                                            |
| Design system and not-found content                  | Static content; no page data refresh                                                                                        |

The repository socket remains `/api/v1/repositories/:repositoryId/live`. Pages
without an accessible repository use `/api/v1/live`. Both routes require the
existing authenticated membership and same-origin checks. Notifications contain
topics and revisions; the HTTP endpoints still authorize and return page data.

Inventory, teammate, and linked-account changes enqueue notifications in the same
transaction as the database write. Timestamp-only account updates during
authentication do not enqueue changes. Inventory observation bookkeeping also
avoids application notifications.

The client ignores duplicate or older revisions per topic. Changes received while
a read is in flight coalesce into a follow-up read. Reconnection refreshes current
state because the socket does not replay missed events.

## Removed polling

- The shared 60-second HTTP fallback when the socket was disconnected.
- The connection page's 3-second inventory refresh loop.
- The rule test's 10-second retry loop after a failed progress read.

WebSocket heartbeat and reconnect timers remain. Search debounce and the rule-test
timeout remain too; none periodically fetch page data. If the socket fails, the
header shows its reconnect state and offers Retry. The UI no longer silently
switches to polling.

## Deployment verification

1. Deploy the backend migration and frontend together, then reload the browser.
2. Open Reviews and inspect Network. After initial reads and the socket's Ready
   catch-up, an idle page should have no periodic Reviews requests. Ping/pong
   WebSocket frames are expected.
3. Start a dry-run review in another tab. Changed frames with the `review` topic
   should cause HTTP reads and update the run status and open details.
4. Open Connect with no connected repositories. Installation/inventory changes
   should update the page through the application socket.
5. Change a teammate role or linked account in another tab. The Account/Team page
   should refresh on an `account` notification.
6. Interrupt and restore the connection. Expect reconnect attempts and a catch-up
   read when Ready arrives, without timed application-data reads while offline.

Repeated HTTP reads during actual database changes are expected. To distinguish
those from a reconnect problem, correlate each read with Changed or Ready frames.
