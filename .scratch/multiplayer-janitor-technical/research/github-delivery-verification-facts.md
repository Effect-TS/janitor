# GitHub delivery verification facts

Checked 2026-09-11. Documentation and repository inspection only. No live requests, messages, repository mutations, or App changes were performed. This note supports [Verify Slack and GitHub delivery integration](../issues/14-platform-delivery-verification.md); it does not establish that integration passed.

## Review membership is the main unresolved assumption

GitHub defines a review as a group of review comments, a state, and an optional body. `GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/comments` lists its comments, with `page` and `per_page`, maximum 100. Review and review-comment reads accept installation tokens with Pull requests read permission. Pending reviews omit `submitted_at`. The REST examples include both `pull_request_review_id` and `in_reply_to_id` on comments. [Review API](https://docs.github.com/en/rest/pulls/reviews)

`in_reply_to_id` identifies the comment being replied to. It does not by itself say whether the reply was composed during a submitted review or sent later. Likewise, a non-null `pull_request_review_id` establishes association with a review, not an independently documented classification of the UI action that created the comment. Replies can be created through the dedicated reply endpoint; that endpoint requires Pull requests write. Review comments can also be edited or deleted. [Review-comment API](https://docs.github.com/en/rest/pulls/comments)

The reviewed documentation does not guarantee that every standalone comment produces a corresponding submitted-review webhook, that later replies always receive a different review ID, or that an immediately paginated review-comment listing is complete at submission time. Those are live fixture questions. Never discard an inline event merely because its review ID has already been seen. Never infer batch membership from a short delay or delivery arrival order.

The fixture needs raw payloads and REST representations for these separate cases:

- A submitted review containing two top-level inline comments and a body.
- A submitted review containing a reply to an existing thread.
- A standalone inline comment through the UI and through REST.
- A later reply by the same reviewer, and one by a different teammate.
- A bodyless approval, a comment-only review, and an empty review without actionable text.
- Inline events delivered before and after submission, including redelivery.
- More than one page of comments; an edit and deletion during hydration.

Recommended implementation invariant, subject to fixture evidence: persist every comment contribution ID and its membership decision. Keep submission acceptance separate from hydration completion. Persist observed versions rather than silently replacing an accepted input. A uniqueness constraint prevents assigning one contribution to two instructions. Unclassified comments remain pending and visible instead of being dropped.

There is no documented cross-page historical snapshot for review hydration. Repeating reads can detect some changes, but cannot prove an atomic submission-time image. A deleted comment that was never captured cannot be recovered from a current listing. The product must choose whether an input means the first successfully captured review contents or promises a historical submission snapshot. The former is implementable with an explicit incomplete/uncertain path; the latter is not established by these APIs.

## Failed-delivery access and identity

`GET /app/hook/deliveries`, `GET /app/hook/deliveries/{delivery_id}`, and `POST /app/hook/deliveries/{delivery_id}/attempts` require an App JWT. Installation tokens and GitHub App user tokens do not work. Listing uses an opaque `cursor` from the `Link` header and `per_page` up to 100. Do not substitute numeric page pagination. The examples show different numeric attempt IDs sharing one `guid`, with `redelivery` distinguishing attempts. Detail includes the original request headers and payload. The current API also exposes a status filter whose documented failure range is 400–599. [App webhook API](https://docs.github.com/en/rest/apps/webhooks)

GitHub preserves the original `X-GitHub-Delivery` on redelivery. That is the logical delivery identity; a numeric attempt ID is not an agent-input identity. [Webhook best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)

GitHub does not retry failed deliveries automatically. Delivery details and redelivery are available for the preceding three days on GitHub.com. [Redelivery documentation](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks), [retention announcement](https://github.blog/changelog/2023-10-17-webhook-delivery-logs-will-only-be-retained-for-3-days/)

Proposed Janitor scan algorithm, not a GitHub guarantee or an accepted product decision:

1. Schedule a scan every five minutes. Start at the newest page each time. Follow opaque next links to completion across the retained window; persist an interrupted traversal for resumption, then restart at the newest page after completing it. At MVP volume, scanning the complete retained window avoids an undocumented assumption about strict timestamp sorting or cursor stability.
2. Store attempt ID, GUID, observed outcome, and recovery state. Inspect all statuses initially; filtering only HTTP failure codes could omit timeout or connection failures until live response shapes prove their classification.
3. Group attempts by GUID and consult Janitor's durable ingress record before requesting redelivery. A successful durable intake, including a durable rejection, is terminal for intake recovery. A success HTTP code alone cannot replace Janitor's ledger.
4. Request redelivery only when the logical event lacks terminal intake. Back off and respect rate limits. A lost redelivery response may cause another delivery attempt, but durable GUID uniqueness must prevent another agent input.
5. Check current authorization for a first-time admission. Preserve the recorded decision for retries. Do not revive an instruction rejected before an account was linked, a repository connected, or a member restored.
6. Record last completed coverage and earliest outstanding failure. Surface a degraded intake state before the three-day boundary is exceeded. Once expired, current PR state cannot reconstruct all missed, edited, or deleted instructions. Do not silently claim successful catch-up.

Exact cadence and the visible response to an irrecoverable intake gap require an explicit decision. Five minutes is a proposal. No installation permission upgrade is needed merely to call App-level delivery APIs; the service needs access to the App signing key, held outside agent workspaces.

## Reconciling replies after response loss

PR conversation comments use the issue-comments API, with paginated listing and raw Markdown bodies. Installation tokens can list with Issues read or Pull requests read; creating comments needs Issues write or Pull requests write. These comments are separate from inline review replies. [Issue-comment API](https://docs.github.com/en/rest/issues/comments)

Proposed operation marker: append `<!-- janitor-operation:<opaque-operation-id> -->` to the raw Markdown body. Persist the operation before sending, including repository numeric ID, PR number, output kind, target thread ID, expected App author ID, and payload digest. On response loss, paginate the appropriate comment collection and require exact marker, author, and target matches. This is an application reconciliation convention, not documented GitHub idempotency. Verify marker preservation live before adopting it.

A matching comment is positive evidence and supplies the publication ID. No match is not proof of non-publication: the comment could be delayed, edited, deleted, inaccessible, or missed during concurrent pagination. Bounded repeated scans may end with an unresolved outcome. Do not automatically POST again solely because lookup was negative. A deleted reply target also needs an unresolved/error path; posting elsewhere changes the approved destination.

## Existing Janitor code

- [WebhookEvent.ts](../../../packages/domain/src/GitHub/WebhookEvent.ts) does not currently include `issue_comment` or `pull_request_review_comment` variants. Submitted, edited, and dismissed review events are modeled.
- [PullRequestReview.ts](../../../packages/domain/src/GitHub/WebhookEvent/PullRequestReview.ts) preserves review ID, author numeric ID/login, body, commit ID, submission time, and state. It does not supply inline review membership or hydrate comments.
- [WebhookJournal.ts](../../../apps/cluster/src/GitHub/WebhookJournal.ts) uses `ON CONFLICT (delivery_id) DO NOTHING` and enqueues projection within the insertion transaction. This is a useful existing transport-deduplication boundary, not yet contribution deduplication or authorization rejection storage.
- [WebhookVerifier.ts](../../../apps/cluster/src/Ingress/WebhookVerifier.ts) validates SHA-256 HMAC against raw request bytes through Web Crypto. Recovery via original webhook redelivery can reuse this boundary. An API response reserialized as JSON is not the original signed byte sequence.
- The existing projection states `pending`, `projected`, `unsupported`, and `failed` do not express multiplayer accepted/rejected, hydrated/incomplete, or publication-uncertain outcomes. Add separate session contracts rather than interpreting `projected` as agent acceptance.

## Decisions and evidence still needed

The sharpest unresolved question is contribution grouping. The API names alone do not prove that a submitted review can always be distinguished from standalone or later inline feedback without loss. Run the listed live cases before locking that algorithm. Separately settle hydration snapshot semantics, a bounded recovery guarantee after outages, and visible unresolved publication. A negative marker lookup cannot support an exactly-once publication claim.
