# First GitHub review delivery experiment

Prepared 2026-09-12 for [Verify Slack and GitHub delivery integration](../issues/14-platform-delivery-verification.md). The user enabled the two missing subscriptions. [Read-only evidence](platform-github-access-current.json) confirms both App and installation now subscribe to `issue_comment`, `pull_request_review`, and `pull_request_review_comment`. Current repository permissions and App-JWT delivery access remain sufficient. No GitHub test writes have run.

## Prepared driver and scope

[probe-github-reviews.mjs](../prototype/platform-fixture/probe-github-reviews.mjs) is syntax-checked and ready for authorization. It runs only when `FIXTURE_ALLOW_GITHUB_REVIEWS=Effect-TS/slopcop-sandbox`. It also requires `FIXTURE_APP_ENV_FILE` and an absolute `FIXTURE_REPORT_PATH`. Invoke through the local wrapper with task `github-reviews`. It derives a short-lived installation token restricted to repository ID 1323166030 with Contents and Pull requests write permissions. It checks the App and signed-in user's identity before writes. No credentials are printed or stored in evidence.

The test uses the existing `effect-janitor` App, installation 158746421, and the signed-in `gh` account `IMax153`. These human-authored messages require explicit authorization. Subscription setup alone is not that authorization.

The driver creates one random temporary branch, a four-line text file on that branch, and one draft PR against the repository's default branch. It does not update the default branch. It performs these interactions in order:

1. `IMax153` submits a COMMENT review with a body and two inline comments. Read its comments with one-result pages and save the first snapshot.
2. `IMax153` publishes one standalone inline comment and a later reply to an inline comment from the earlier batch.
3. The App replies to the standalone inline comment with a unique hidden operation marker.
4. `IMax153` adds one mentioned general PR comment, and the App adds a marked overall reply.
5. `IMax153` submits a body-only COMMENT review and an empty-body APPROVE review, testing feedback with no actionable text. The PR remains draft and is never merged.
6. Read the appropriate paginated comment collections and match each App reply's marker, author, and target. Record the batch membership again after the later reply.
7. `IMax153` edits one of the original inline comments. Read another batch snapshot and list all reviews/comments for relationship inspection.
8. Make three bounded App-delivery scans, five seconds apart. Filter summaries by installation, repository, event type, and test start before reading detail. Verify the fixture PR again from each payload. Save only contribution fields and transport identifiers for this PR, excluding webhook URL, secret headers, and unrelated payloads.

This creates three explicit reviews, seven comments/replies including the two batch inline comments, and one inline edit. GitHub may automatically create additional review records for individually published inline comments; those relationships are part of the observation. No further review or comment scenarios run in this batch.

## What this establishes and what it does not

The test records actual REST-created review/comment relationships and captured webhook contributions. It does not assume beforehand that `pull_request_review_id` or `in_reply_to_id` alone solves grouping. Later analysis must replay captures in both event orders and decide the classifier from evidence. Missing expected event types fail the capture check and remain unresolved; a fixed observation window is a fixture bound, not a completeness guarantee or a production debounce.

This first driver does not create pending-review replies through the GitHub UI, simulate concurrent human edits during a page fetch, inject errors into the production webhook, or request App webhook redelivery. Those remain separate checks. The App's webhook URL and secret remain unchanged. List pagination uses returned next links, including opaque delivery cursors, with a bounded traversal to prevent runaway scans.

## Cleanup and uncertain results

The driver journals each write intent before sending and never automatically retries an uncertain content write. On an unknown PR-creation result, it attempts positive reconciliation using the unique head branch before cleanup. Unknown results remain visible in the report.

Cleanup closes the draft PR unmerged, verifies that state, deletes the temporary branch and verifies absence, and revokes the installation token. Submitted reviews and comments remain on the closed PR as fixture history; this is not erasure. Failures in cleanup are recorded for repair. No App installation or subscription is removed. No Slack message or Worker change is part of this run.

Sources checked during preparation: [GitHub reviews API](https://docs.github.com/en/rest/pulls/reviews), [review comments API](https://docs.github.com/en/rest/pulls/comments), and [App webhook delivery API](https://docs.github.com/en/rest/apps/webhooks).
