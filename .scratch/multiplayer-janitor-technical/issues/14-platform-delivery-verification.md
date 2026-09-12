# Verify Slack and GitHub delivery integration

Type: task
Labels: wayfinder:task
Status: resolved
Mode: HITL
Parent: ../map.md
Blocked by: 06, 07

## Question

Can the selected Slack and GitHub integration implement the accepted identity and delivery contracts under overlapping events, outages, and uncertain publication?

Prepare a disposable fixture, required access/scopes, and reproducible acceptance checks before any live action. Do not send messages, install apps, change remote subscriptions, or mutate repositories without authorization. Read-only code and documentation checks and local fixtures may proceed. Local mocks do not establish actual platform behavior.

Verify these contracts and record concrete algorithms and evidence:

- Slack private-thread history with the selected bot installation, pagination, initialization boundary, mention/message overlap, concurrent incoming messages, and exclusion of unrelated channel history. Specify exact subscriptions and minimal scopes.
- Submitted-review aggregation with inline events arriving before or after review submission; standalone inline comments, later replies, empty reviews, pagination, and edits during hydration. Prove one instruction per logical feedback contribution and no lost standalone feedback without relying on event ordering or a timing debounce.
- Platform signature checks, normalized IDs, authorization/removal races, durable rejection, bot-loop prevention, and immutable accepted retries.
- Durable GitHub failed-delivery recovery, including exact scan cadence, cursor/overlap strategy, permissions, retention limits, and authorization treatment. Specify Slack recovery after retry exhaustion, its bounded coverage, and how unrecoverable intake gaps become visible without replaying rejected or pre-session history. Return any required product tradeoff to the delivery ticket.
- Ambiguous Slack posts and GitHub replies after response loss. Select verifiable operation markers and lookup procedures; test pagination and delayed visibility, message deletion, unavailable reply targets, and the unresolved-result path. Do not treat undocumented idempotency fields or a negative lookup alone as proof that a send did not happen.
- Status update coalescing, substantive output ordering and size limits, rate-limit scheduling, private onboarding failure, and home-thread access loss/restoration. Retain final/error output while allowing superseded intermediate progress to be coalesced.

No successful live integration is implied by the delivery decision. Record unsupported assumptions and resolve any behavior changes before the implementation-ready spec.

## Comments

### Verification preparation, 2026-09-11

The ticket remains claimed. Documentation research, local contract checks, and a read-only GitHub App access check are complete. Live delivery verification has not run.

- [Slack API findings](../research/slack-delivery-verification-facts.md) cover private-thread access, metadata, retries, bounded history recovery, ephemeral visibility, and access loss.
- [GitHub API and local-code findings](../research/github-delivery-verification-facts.md) cover review membership uncertainty, mutable hydration, App delivery recovery, markers, and missing event schemas.
- [Disposable fixture and access plan](../research/platform-fixture-plan.md) gives concrete destinations, scope proposals, mutation bounds, checks, cleanup, and candidate recovery defaults. It is prepared for review, not authorization or a deployed fixture.
- [Local fixture](../prototype/platform-fixture/README.md) passed 17 checks with Node 24 through Vite+. These are limited local contract checks; they do not establish distributed admission, real webhook normalization, remote pagination, GitHub grouping, or platform delivery.
- [Read-only GitHub access evidence](../research/platform-github-access.json) confirms repository write permissions and App delivery-list access. The existing App subscribes to submitted reviews but lacks `pull_request_review_comment` and `issue_comment`. No settings or subscriptions were changed.

The next access prerequisite is a selected private Slack test channel and app. An asynchronous question asks for workspace/channel/app IDs and the local path containing its bot token and signing secret, or confirmation that no app exists. No Slack credentials were found in the existing production environment file. A proposed disposable Slack manifest is linked from the fixture README. This turn used no remote writes or messages.

Before live execution, settle the GitHub webhook source, prepare the receiver and API driver for the selected apps, and obtain scoped authorization for fixture messages/reviews and any app/deployment changes. Prefer an isolated GitHub test app over changing the production receiver. Existing publication-test authorization does not authorize this new set of messages and subscriptions.

Two technical limits must return to the accepted delivery decision after fixture results: Slack recovery cannot promise messages deleted before capture or a never-received start mention; GitHub hydration cannot promise an exact historical snapshot across mutable pages. The proposed five-minute recovery schedules and user-visible gap treatment remain proposals. Review-versus-standalone contribution classification still needs live evidence. Do not resolve this ticket or spec readiness on the strength of the local tests.

The [verification progress report](../research/platform-delivery-results.md) records executed checks and repository validation separately from the live fixture plan.

### Slack destination selected

The user selected `effectfulworkspace.slack.com` and private channel `janitor-test`, and confirmed there is no Slack app yet. Prepared the [setup wizard](../prototype/platform-fixture/setup-slack.sh) and [bootstrap manifest](../prototype/platform-fixture/slack-bootstrap-manifest.json). The wizard captures app/channel identifiers and credentials into `$HOME/.config/janitor/platform-fixture.env`; workspace ID can be derived afterward. Event subscriptions remain absent from the bootstrap manifest until a real receiver is ready. No installation, deployment, or messages were performed by the agent. Live verification remains pending.

### Slack installation checked, 2026-09-12

The user completed setup. Live read-only checks confirm the correct workspace, all five scopes, bot membership, and history access in private `janitor-test`. [Evidence](../research/platform-slack-access.json) records the IDs and results. No ordinary root was available to check replies yet.

The [receiver and local probe](../prototype/platform-fixture/README.md) are prepared; six local Workerd checks passed including persisted receipts across restart. The first bounded live script would post four disposable bot messages in one thread, update one, check pagination/metadata, and delete its messages. It has not run. The receiver has not been deployed or connected to Slack. This setup confirmation does not authorize posting test messages. The remaining GitHub subscription and grouping checks are unchanged.

### Authorized first live run, 2026-09-12

The user authorized deploying the temporary receiver and a four-message Slack check with one update and cleanup. The receiver is deployed at `https://janitor-platform-delivery-fixture.matechs.workers.dev`, with secrets supplied separately. [Readiness evidence](../research/platform-receiver-deployment.json) verifies protected journal access and a signed URL challenge. It remains deployed for connecting Slack; no Slack subscriptions have been enabled by the agent.

The [first live API result](../research/platform-slack-live-1f1bf920-d806-43c1-b563-693f8dce2f4e.json) records four successful posts and four successful deletes, with no uncertain publication. The first read-only preflight used JSON POST for `conversations.info` and failed `invalid_arguments` before posting anything; the driver was corrected to use GET for read methods. The subsequent live run reached paginated private-thread reads but failed its marker uniqueness assertion with two matches rather than one. The fixture had concatenated page rows without deduplicating source message IDs. It now deduplicates by `ts`, checks metadata consistency, and records page timestamp evidence. The corrected live path has not rerun; the raw first-run pages were not retained, so duplicate-row identity is an explanation to verify rather than a fully recorded platform finding. The update and remaining assertions were not reached. Do not count this as a passing readback/reconciliation check.

Next manual step: configure app `A0C284F2FSL` Event Subscriptions with the receiver URL ending `/slack/events`, enable the proposed bot events, and save. The four-message allowance has been used; any further live message batch must be accounted for separately. Retain the temporary receiver only while these integration checks continue, then delete it and its fixture namespace.

### Connected receiver and successful rerun

The user confirmed subscription setup and authorized one more four-message batch. [Rerun](../research/platform-slack-live.json) passes actual private-thread pagination, unique metadata readback, simulated lost-return reconciliation, and progress update. Four created messages were deleted, with no uncertainty. The pages prove that Slack repeats the root across pages and returns replies in an order requiring explicit sorting.

[Twelve real callbacks](../research/platform-slack-webhooks.json) reached the deployed receiver for message creation, changes, and deletion. Original bot posts have no subtype, so bot identity checks are required. Next, ask the human to create a context root, mention the fixture bot in a reply, and send an unmentioned follow-up. This will expose real mention/message overlap and initial-context boundaries without agent-authored impersonation. The receiver records events only; it does not run an agent or reply. The broader ticket remains claimed.

### Human input verified; retry check prepared

[Captured human messages](../research/platform-slack-human.json) prove mention/message overlap on one source identity, delivery of an ordinary unmentioned follow-up, and a live history boundary excluding that later reply. Local replay of the actual envelopes in both orders yields one initiating input and one follow-up, using synthetic eligibility. The context root is not a separate instruction. No production admission or agent execution is implied.

Armed one controlled failure after receipt persistence for the next eligible Slack event, recorded in [pending retry evidence](../research/platform-slack-retry-pending.json). Ask the human to send one plain reply in the same test thread; then inspect actual Slack retry attempts and durable receipt uniqueness. The counter automatically clears after its one failure. Reset it manually if the test is abandoned. Receiver and human-created test messages remain in place for this check; prior bot batches are deleted.

### Real Slack retry passed

[Retry evidence](../research/platform-slack-retry.json) records one stored receipt for two attempts of the same Slack event: the initial callback committed and returned 503, then Slack retry number 1 was acknowledged. Local replay produces one instruction with synthetic eligibility. Failure counters are now zero and the retry experiment is complete. No additional Slack posts were made. Receiver and human test thread remain for remaining verification; this does not resolve the full platform-delivery ticket.

### GitHub setup handoff

The user asked for the next manual action. Recommend enabling Issue comment and Pull request review comment on the existing `effect-janitor` App, then capturing only sandbox fixture deliveries through its already-accessible App delivery API. The [updated plan](../research/platform-fixture-plan.md#proposed-github-setup-handoff-2026-09-12) explains the change from the earlier separate-App preference and the app-wide effect of subscriptions. Preserve the current webhook URL and secret; no production failure injection. Subscription changes and test writes have not been performed. This manual setup does not itself authorize posting reviews/comments.

### GitHub subscriptions verified and driver prepared

The user completed the GitHub setup. [Current access evidence](../research/platform-github-access-current.json) verifies both added subscriptions on the App and installation. Prepared the [bounded review experiment](../research/github-review-fixture-plan.md) and its guarded driver. It creates one temporary branch/draft PR, three explicit reviews, seven comments/replies, and one edit, using the App and signed-in `IMax153` account. It captures only sandbox fixture delivery details, closes the PR unmerged, deletes the branch, and revokes its token. Submitted review/comment history remains on the closed PR.

The driver passes syntax checking but has not executed. Explicit approval for App and human-authored content is the next prerequisite. The production webhook URL and secret remain unchanged. This first batch will establish REST-created relationships and marker lookup, while pending-review UI replies, delivery failure handling, and complete classification replay remain later checks within this ticket.

### GitHub experiment executed and cleaned up

The authorized fixture completed all content operations on [sandbox PR #8](https://github.com/Effect-TS/slopcop-sandbox/pull/8). [Execution report](../research/platform-github-reviews.json) verifies reply marker lookup, closed/unmerged PR, deleted branch, and revoked token. Its initial webhook scan exceeded the page bound. A subsequent read-only [capture](../research/platform-github-review-deliveries.json) obtained all fourteen expected events, with no new posts.

GitHub delivery attempt IDs exceeded JavaScript's safe integer range; the initial parser rounded them and caused detail GET 404s. The corrected fixture preserves exact decimal IDs through source-aware JSON parsing. All expected details then fetched successfully. Treat lossless numeric ID decoding as a requirement for the integration. Nineteen local contract checks pass, including two parser regressions.

Observed standalone and later inline feedback each received a distinct review ID and both review/comment events. The original batch retained its two comment members. [Seven local replay scenarios](../research/platform-github-review-replay.json) establish the candidate grouping for those captured REST cases, with no duplicate human instructions; a missing body-only review still requires delivery recovery. The [results report](../research/platform-delivery-results.md#authorized-github-experiment-2026-09-12) records full findings and limits.

The ticket stays claimed. Pending-review UI replies, remaining failure/recovery and access scenarios, production runtime lossless parsing, hydration completeness, and acceptance of narrowed recovery guarantees remain outstanding. Review/comment fixture history persists on the closed PR. The Slack receiver and human test thread remain intentionally available; no fault counter is armed.

### Remaining automated verification completed

The user requested all remaining verification possible without further back-and-forth. The [verification handoff](../research/platform-verification-summary.md) consolidates the resulting live evidence, local tests, limits, cleanup and decisions. Pending-review replies were exercised through GitHub GraphQL, so no browser walkthrough was needed. The new sandbox PR #9 is closed unmerged, its branch deleted and token revoked. Actual GitHub redelivery preserved the GUID, a full delivery scan completed, and the large-ID parser passed in Workerd. Additional Slack deletion, history recovery and ephemeral/error API checks passed. Twenty-two local contract tests cover the remaining candidate output policies and input edge cases.

The ticket remains claimed because acceptance of bounded recovery/hydration guarantees and disposition of manual Slack visibility/membership checks is still required. Do not label local queue state changes as actual channel removal/restoration or an ephemeral success response as proof the user saw it. All available automated evidence has been captured; no further user-run GitHub fixture is currently needed.

Final cleanup verified: temporary Worker removed, no matching namespace remains, and both endpoint checks return 404. Slack Event Subscriptions need manual disabling. Local verification passed 22 checks; the full repository suite had one timeout among 533 tests, and that file passed both tests on focused rerun. Repository checks retain six errors in earlier execution probes. Full evidence and remaining decisions are in the [handoff](../research/platform-verification-summary.md).

### Ephemeral visibility confirmed

The recipient did not see the first ephemeral test and requested another. Slack accepted the second attempt, and the recipient confirmed, "I see it". [Retry evidence](../research/platform-slack-ephemeral-retry.json) records that confirmation. Human-visible ephemeral delivery passes for this attempt; persistent or guaranteed delivery is not implied. Actual membership removal/restoration and acceptance of the proposed recovery limits remain outstanding.

## Answer

The user asked to proceed after automated verification and recipient-confirmed ephemeral visibility. Close this planning gate using the bounded guarantees below. Defer actual private-channel membership removal/restoration to implementation acceptance; it remains unverified remotely, not a passing live test.

The [verification handoff](../research/platform-verification-summary.md) records live provider evidence, local policy tests, reproducible probes, validation failures and cleanup separately. GitHub pending-review grouping, later replies, redelivery identity, complete retained-window scanning, and lossless Workerd ID parsing passed. Slack private history, real retry and mention overlap passed; the recipient confirmed the second ephemeral attempt. Candidate admission and output policies passed 22 local tests. These do not establish a production end-to-end integration.

Carry these constraints into the implementation spec and delivery contract:

- Freeze the first successfully captured feedback version. Mutable paginated APIs cannot guarantee historical submission text. Keep incomplete hydration explicit and pending rather than silently dropping contributions.
- Use five-minute recovery scans, with durable resumable GitHub cursors and rate-aware scheduling, and overlapping Slack scans of known home threads after their start boundaries. Preserve admission/rejection decisions and report overdue scans or known gaps. Deleted or uncaptured original text, expired deliveries and never-received Slack starts can be unrecoverable. Do not claim lossless catch-up.
- Preserve uncertain output for positive reconciliation; a missing marker does not justify reposting. Retain output during loss of access and resume after restoration. The live removal/restoration acceptance test remains required before shipping that integration.

Both disposable PRs are closed, their branches deleted and scoped tokens revoked. The receiver and namespace were removed. Disabling Slack Event Subscriptions is a remaining human cleanup action, separate from planning readiness. The repository suite had one timeout that passed in isolation, and repository checks retain six errors in earlier execution probes. Neither result is described as a fully green repository check.
