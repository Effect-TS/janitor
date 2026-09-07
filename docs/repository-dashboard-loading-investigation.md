# Repository dashboard loading investigation

September 7, 2026. Repository: `Effect-TS/effect`, ID `221458136`.

Mike reported approximately 30 seconds on the Overview screen's “Loading repository…” state. The screenshot shows that the application shell and repository switcher have already rendered. His exact request time and location were not available during this investigation.

## Finding

Overview has an unnecessary dependency on the entire repository detail request. This explains why it can remain in a loading state after the repository is already known. The available measurements do **not** establish the cause of Mike's full 30-second wait.

In `apps/web/src/components/workspace.ts`:

- `detailPanel` checks `model.detail` before considering the Overview section. However, Overview only reads the repository list, not configuration, reconciliation history, or test candidates.
- `FetchDetail` waits for configuration, test candidates, and reconciliation history together. Its concurrency limit is two, so one of the three requests starts only after another finishes. No partial result reaches the model.
- A slow test-candidate request therefore blocks Overview. A reconciliation or configuration failure also prevents it from rendering.
- `getJson` has no application-level deadline. The ten-second background poll avoids duplicating an in-flight request, so polling does not rescue a hung detail request.

These dependencies also exist in the deployed release, `039b349`; they were not introduced by the frontend cleanups.

The test-candidate endpoint calls `LabelingTest.items`, which loads up to 25 open entities through `GitHubReadModel.listOpenEntities`. That path fetches full entity rows and then makes six sequential collection queries for PR metadata, labels, collection completeness, changed files, checks, and reviews. The picker does not need all of this data. This is bounded work, not an N+1 query per PR, but it adds database round trips and unnecessary data transfer.

## Production evidence

Read-only measurements taken around 15:09–15:13 UTC on September 7:

- Neon compute was active in `aws-us-east-1`, fixed at 0.25 CU, with auto-suspend disabled. There is no evidence here of a database wake-up delay.
- `Effect-TS/effect` had 242 open synchronized entities.
- A direct TLS database connection took 202 ms in the final sample. This bypasses the Worker and Hyperdrive, so it is not an end-to-end API measurement.
- Fetching the 25 newest open entity rows took 68 ms. The six associated collection reads each took 18–33 ms. They included 478 changed-file rows, despite the caller only needing test-picker information. Fetching 50 reconciliation rows took 21 ms.
- These are individual warm samples from Artemis, not a latency distribution or a reproduction of Mike's network path. The database had no `pg_stat_statements` extension, so historical query timings were unavailable.

Cloudflare GraphQL analytics for the API Worker over approximately the preceding 24 hours showed:

| Datacenter | Request duration p50 | Request duration p99 |
| ---------- | -------------------: | -------------------: |
| EWR        |                78 ms |               627 ms |
| IAD        |                99 ms |             1,060 ms |
| MXP        |               460 ms |             2,722 ms |
| VIE        |               467 ms |             1,492 ms |

The slowest recorded request-duration sample was 4.45 seconds at 13:12:42 UTC on September 7 in EWR. These are adaptive analytics across the API Worker, not measurements of one endpoint, repository, or user. Their schema reports request durations in microseconds; the figures above are converted to milliseconds. They cannot rule out an unsampled outlier or delay before a request reached the Worker.

Some datacenters had much longer invocation wall times with zero request-duration values. Those figures cannot be treated as dashboard HTTP latency. This Worker also runs queues, cron, and other background work.

The [Workers metrics API](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/) was accessible. The more detailed [Workers Observability query API](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/) returned HTTP 403 with the configured token. Cloudflare documents `Workers Observability Write` as the required permission for that query endpoint. No token permissions or Access policies were changed. The available browser session stopped at GitHub sign-in, so an authenticated browser waterfall was unavailable.

## Recommended changes

1. Render Overview from the repository list as soon as that list is available. It should not depend on `FetchDetail`.
2. Load data by section: configuration for policy/rule pages, reconciliation history for Activity, and consent for Settings. Load test candidates when an editor needs them. Keep each result and failure independent.
3. Give the test picker a lightweight query that selects only its displayed fields. Keep full entity assembly for actual policy evaluation.
4. Add bounded read deadlines with an explicit retry state, plus per-endpoint request timing and correlation IDs. Verify that late responses cannot overwrite a different repository or newer request.

Before attributing the reported 30 seconds to a particular cause, obtain Mike's approximate request time and a browser network waterfall showing queueing, TTFB, download time, and request initiators. Correlate it with request-level Worker logs. Specifically check whether one request was slow, the browser delayed several requests, or a stale response was discarded while a later refresh completed.

No production changes were made during this investigation. The frontend cleanups were committed separately as `a2d670d`, `394de61`, and `d0140b6`; all 168 frontend tests, `vp check`, and the frontend build passed. Existing lint and bundle-size warnings remain.
