# Platform delivery verification progress

Recorded 2026-09-11. [Ticket](../issues/14-platform-delivery-verification.md) remains claimed.

## Executed

- `vp install` succeeded with no dependency changes.
- The [local fixture](../prototype/platform-fixture/README.md) passed all 17 checks on Node 24.19.0. Re-run using its documented wrapper, which invokes `vp run --no-cache verify` in an isolated temporary package and cleans it up.
- A read-only GitHub inspection authenticated with an App JWT and successfully read App metadata, installation metadata, webhook configuration, and one page of delivery summaries. [Sanitized evidence](platform-github-access.json) records only capability facts; no payloads, URLs, keys, or tokens were retained. The App and installation have Contents/Pull requests write access, but neither `issue_comment` nor `pull_request_review_comment` is subscribed.
- Official documentation and local code were inspected in the [Slack](slack-delivery-verification-facts.md) and [GitHub](github-delivery-verification-facts.md) reports.

No Slack request was made. No messages or reviews were posted. No repository, App configuration, subscription, or deployment was changed. Local temporary test directories were removed; there are no live fixture resources to clean up.

## Evidence limits

The 17 local checks exercise a candidate policy model, not the production adapter. Signature checks use synthetic bytes; authorization changes are serialized in a single in-memory SQLite connection; history uses synthetic combined pages; publication reconciliation receives already matched candidates. Real envelope normalization, durable crash recovery, concurrent distributed admission, platform API behavior, and GitHub contribution grouping remain unverified. See the fixture README for the complete boundaries.

The prepared [live plan](platform-fixture-plan.md) describes checks and access requirements. It is not an executed experiment. Its receiver and API driver still need preparation for the selected apps. All recovery schedules and narrowed history guarantees are proposals until accepted. This evidence cannot close the ticket or unblock the final spec.

## Repository validation

Formatting passed. `vp check` then failed with 7 errors and 608 warnings. All seven errors point to the earlier isolated repository/runner fixtures: missing Sandbox and Cloudflare types, HTTP-model TimeoutError typing, and runner Layer context typing. None points to the new platform fixture. These isolated probes use different dependencies; this task did not alter production dependencies or suppress their checks.

`vp test` passed all 533 tests across 95 files in 161.15 seconds. The isolated platform fixture is verified separately by its 17-check command. The new fixture also produces Effect-style warnings because it deliberately uses standalone Node APIs; no new errors were reported for it.

## Installed Slack app, 2026-09-12

The user completed the Slack setup wizard. The credential file exists outside the repository with mode 0600. A live read-only check passed `auth.test`, `conversations.info`, and `conversations.history`. Workspace `T05479Z6JBW` is `effectfulworkspace.slack.com`; app `A0C284F2FSL` belongs to bot `B0C1FMBA7MF`, user `U0C0YCF3B1D`. The bot is a member of private, unarchived channel `C0C19USKLPQ`, named `janitor-test`. Slack reports all five requested bot scopes. [Sanitized access evidence](platform-slack-access.json) contains no message bodies or secrets.

The two available history entries were not ordinary root messages, so private-thread `conversations.replies` and actual pagination remain unverified. No test messages were posted.

Prepared a [receiver](../prototype/platform-fixture/receiver.mjs) and [deployment configuration](../prototype/platform-fixture/wrangler.json) restricted to the selected app/workspace/channel. Six local Workerd checks passed using Miniflare `5.20260911.0-alpha`: signature/control authentication, signed URL challenge, duplicate receipts and destination isolation, failure before persistence, persisted receipt recovery after failed acknowledgment and runtime restart, and authenticated export cursors. The probe uses Miniflare's V4 option converter and explicit V5 `resourcePersistencePath`; the first restart check caught that the legacy persistence option alone did not preserve state. This was a local fixture configuration failure and was corrected before the passing run. Local temporary state was removed.

This receiver is a capture fixture, not the multiplayer admission implementation. It does not dispatch agent work or establish Slack's actual retry timing. Its authenticated export includes temporary raw fixture payloads; public evidence uses IDs and hashes. A signing secret and separate random control token must be supplied at deployment, never committed. The bot token is not needed by the receiver.

Prepared a guarded [Slack API driver](../prototype/platform-fixture/probe-slack.mjs) for one root and three bot replies, metadata readback across two-result pages, a locally simulated lost return value, and a progress update. It deletes known fixture messages in reverse order and records any uncertain publication without an automatic retry. This driver passed syntax review but has not run against Slack. It does not exercise human input, ephemeral messages, real transport loss, access revocation, or every requirement of this ticket.

## First authorized deployment and Slack write check

The user authorized the temporary receiver and four-message check. [Deployment evidence](platform-receiver-deployment.json) records the URL, code hash, original upload version, and three deployed readiness checks. The Worker is intentionally retained pending Slack subscription configuration. The signing secret and control token are stored as Worker secrets; the bot token stays local.

[Preflight evidence](platform-slack-live-preflight.json) records `conversations.info` rejecting the fixture's JSON POST before any write. Changing read methods to GET corrected that error.

[First-run evidence](platform-slack-live-1f1bf920-d806-43c1-b563-693f8dce2f4e.json) records four posts and four successful cleanup deletes, with no unknown publication. The bot could call paginated private-thread history, but the test failed because the concatenated pages produced two marker matches where it expected one. It had not deduplicated page rows by message timestamp. The driver now deduplicates by `ts`, checks marker consistency across duplicates, and records page timestamps. This correction is syntax-checked, not live-verified; the first run did not retain pages proving whether the two matches shared a timestamp. Progress update and the remaining assertions did not run. No second message batch was posted.

The receiver's signed URL challenge was checked using a locally constructed valid Slack signature. Actual Slack URL verification and event delivery remain pending the app settings change. The app currently has no event subscriptions. The receiver is a remaining temporary remote resource, not completed cleanup.

## Connected receiver and successful rerun, 2026-09-12

The user confirmed Slack subscription setup and authorized another four-message test with cleanup. [Rerun evidence](platform-slack-live.json), run `57381416-ccc4-42bc-8a13-01ba9ac4c4f1`, passes paginated private-thread bot reads, unique metadata reconciliation after locally simulated return-value loss, and a progress update. Four posts and four deletes succeeded, with no uncertain publication. A subsequent read found no fixture root in channel history.

The recorded pages establish the previous fixture mistake. With `limit=2`, Slack returned the root plus two replies in the first page and repeated the root with the remaining reply in the next. The concatenated replies were not chronological. Deduplicate by workspace/channel/message `ts`, then sort precise timestamps before freezing context. Do not assume that page lengths equal the requested number including the root, or that page concatenation is in conversation order.

[Webhook evidence](platform-slack-webhooks.json) records twelve real signed Slack callbacks for the four fixture messages: four original messages, one direct progress edit, four deletions, and three further root `message_changed` events. All twelve were acknowledged and captured. The original bot messages had no subtype but did have bot identity; bot-loop prevention must check author/app identity, not merely subtypes. The receiver is capture-only and this does not prove production admission or agent dispatch.

This establishes actual Slack-to-Worker delivery with the installed app. The previous synthetic challenge check alone did not. Raw event bodies remain only in the protected disposable receiver journal; saved evidence contains IDs, types, and bot flags. The receiver remains deployed for human mention/reply checks and later fault scenarios. The ticket is still claimed: human mention overlap, initialization, real retries and recovery, onboarding/access-loss cases, and GitHub grouping/delivery checks remain outstanding.

## Human messages and initialization boundary

The user sent the requested context root, a mentioned reply, and an unmentioned follow-up. [Human-input evidence](platform-slack-human.json) records four real envelopes for three human messages. The initiating reply generated both `message` and `app_mention` events with distinct delivery IDs and the same source timestamp. The unmentioned follow-up generated a normal `message` event.

Replaying those captured initiating envelopes in both orders through the local admission fixture produced exactly two inputs: the initiating instruction once and the follow-up once. This used synthetic membership eligibility, not actual Janitor account linking. The context root was not admitted as an instruction. A live `conversations.replies` query with `latest` equal to the initiating timestamp and `inclusive=true` returned the root and initiating reply, excluding the already-posted follow-up. This query returned one page; multipage bot history was established in the prior test. No messages were sent or deleted by this read-only check. Human fixture messages remain in the test thread.

Prepared the next real delivery-retry check by setting the receiver's after-persistence failure counter to one, with no before-persistence failure. The next eligible callback commits and receives a single injected 503; the counter then returns to zero automatically. [Pending retry evidence](platform-slack-retry-pending.json) records the prior receipt IDs and attempt count. The human will send one unmentioned thread reply. This has not yet established a real Slack retry. If the experiment is abandoned before that message, reset `/faults` to `{before:0,after:0}` before other tests.

## Actual Slack retry after persistence, 2026-09-12

[Retry evidence](platform-slack-retry.json) records delivery `Ev0C17JGJ1R9`. The receiver committed the first callback and returned the configured 503. Slack retried the same delivery with `x-slack-retry-num: 1`; the receiver acknowledged it and retained exactly one receipt. There are two attempts and one durable payload. Local replay of that captured payload likewise yielded one instruction, with synthetic eligibility rather than production Janitor membership.

The human copied the instruction as a Slack block quote, so its raw text includes an escaped quote marker and trailing newline. An initial fixture assertion that assumed plain text was too strict. The verification accepted that formatting while retaining the original payload unchanged; this was not a delivery failure or a new prompt version. The receiver does not record attempt timestamps, so this run does not establish precise retry latency.

Both failure counters were reset to zero and the pending record marked complete. No agent-authored Slack message was sent. The human test thread and temporary receiver remain available for the remaining checks. This proves the real provider retry and durable transport deduplication path; the broader platform ticket remains claimed, including GitHub review grouping, recovery beyond retry exhaustion, onboarding/access loss, and outstanding acceptance decisions.

## Authorized GitHub experiment, 2026-09-12

The user explicitly authorized the App and `IMax153` test content. [Execution evidence](platform-github-reviews.json) records one branch and draft [PR #8](https://github.com/Effect-TS/slopcop-sandbox/pull/8), three explicit reviews, seven comments/replies, and one inline edit. All content operations completed. Both inline and general PR App replies were found uniquely through paginated listings using their markers, author, and target. Cleanup verified the PR closed unmerged, branch absent, and installation token revoked. Reviews/comments remain on the closed PR. No production webhook setting or Slack resource changed.

The driver's first delivery capture failed at its thirty-page bound before processing the accumulated summaries. The separate read-only [capture evidence](platform-github-review-deliveries.json) subsequently collected all fourteen expected events from the first page: six submitted-review events, five created-inline-comment events, two general-comment events, and the inline edit. All fourteen delivery attempts returned 202 from the existing webhook destination. That HTTP result alone does not prove session admission. The original execution report retains its scan failure; supplemental capture and replay reports record the recovery without rerunning any content writes.

### Exact numeric delivery IDs

The first detail requests returned 404 because normal JavaScript JSON parsing rounded GitHub's numeric delivery attempt IDs. For example, exact ID `3842322426589347840` had become `3842322426589348000`. The corrected Node fixture uses JSON.parse's source-text reviver to preserve unsafe integers as decimal strings before constructing detail URLs. All fourteen detail requests then succeeded. The exact attempt ID and logical delivery GUID have separate roles. Store attempt IDs losslessly; GUID remains the transport event identity.

Two focused parser tests pass, bringing the local contract suite to nineteen checks. A production runtime must verify source-text reviver support or use a lossless JSON parser; coercing an already-rounded number to a string is insufficient. This is a required integration constraint, not a claim that Janitor's existing GitHub response decoder has been fixed.

### Review membership observations

The batch has review ID 5186578176 and contains its two inline comments. The standalone inline comment has a separate empty-body COMMENTED review, 5186578211. The later human reply to a batch comment has another review, 5186578244, plus `in_reply_to_id` pointing at the earlier comment. The App's inline reply similarly has its own review, 5186578276, and Bot author identity. All produced both review and inline webhook events. The body-only review and empty approval produced review events without inline comments.

The batch's comment listing remained the same two members after the later reply. Editing the second batch comment changed subsequent hydration text; the saved earlier snapshot still contains its original text. This supports freezing first-captured input, not promising an exact historical snapshot from later API reads.

[Local replay evidence](platform-github-review-replay.json) passes six order/retry/hydration scenarios with five human instructions each: one batch, one standalone comment, one later reply, one mentioned PR conversation comment, and one body-only review. Bot contributions and the empty approval do not produce instructions. A seventh scenario with all submission envelopes removed recovers the inline-backed inputs by review hydration but necessarily misses the body-only review, which needs delivery recovery. Four human inline comments are assigned once across those instructions.

This candidate classifier uses captured REST-created relationships and known first snapshots. It does not establish pending-review UI reply behavior, concurrent distributed admission, complete hydration during edits/deletions, or production authorization. Those remain explicit limits. The full retained-window scan strategy also needs refinement or measured bounds after the initial scan exceeded thirty pages; fixture-specific capture can stop when all known expected events are found, but production cannot use that oracle.

## Remaining automated verification completed, 2026-09-12

The [consolidated handoff](platform-verification-summary.md) records every available check and its limits. Live API tests established pending-review reply membership, separate later replies, mutation during paginated hydration, and rejection of deleted inline targets. PR #9 is closed, its branch deleted, and its installation token revoked. Fourteen expected webhook events were captured. Real GitHub redelivery retained its original GUID under a new exact attempt ID. A complete retained-window scan read 7,384 summaries over 74 pages in approximately 12 seconds. Workerd preserved the large numeric IDs exactly.

Slack checks covered scoped thread history, deleted-marker reconciliation, ephemeral API acceptance, invalid recipient/authentication errors, and local replay of retained human history. Persistent local output-policy tests cover ordering, Unicode splitting, coalescing, Retry-After, unavailable access and restoration. These do not establish actual provider throttling, multi-hour outage recovery, or real channel membership removal/restoration. Human confirmation of ephemeral visibility remains pending.

The receiver and matching Durable Object namespace are deleted, verified through control-plane/public 404 responses and zero matching namespaces. All ordinary bot fixture posts were removed. Human messages, closed-PR review history, the Slack App, and owner-only local credentials remain. Slack Event Subscriptions still require manual disabling because their configured receiver no longer exists. See [cleanup evidence](platform-receiver-cleanup.json).

`vp install` passed. All 22 local delivery contract tests and the local Workerd JSON probe passed. The full `vp test` run had 532 passing tests and one 5-second timeout in `GitHubAccess.test.ts`; a focused rerun of that file passed both tests. The full run therefore was not green, although the timeout did not reproduce in isolation. `vp check` passed formatting but reported six errors in earlier repository/runner probes: missing sandbox/Cloudflare types and Effect diagnostics. None of those six errors are in the platform-delivery fixture.

The ticket remains claimed. The proposed bounded recovery guarantees and disposition of the remaining manual Slack checks still need acceptance; no production implementation or lossless recovery guarantee is inferred from these probes.

### Ephemeral visibility confirmed

The recipient did not see the first ephemeral test and requested another. Slack accepted the second attempt, and the recipient confirmed, "I see it". [Retry evidence](platform-slack-ephemeral-retry.json) records that confirmation. Human-visible ephemeral delivery passes for this attempt; persistent or guaranteed delivery is not implied. Actual membership removal/restoration and acceptance of the proposed recovery limits remain outstanding.
