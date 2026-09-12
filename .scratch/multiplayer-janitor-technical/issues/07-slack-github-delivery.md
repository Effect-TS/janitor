# Decide Slack and GitHub event delivery contracts

Type: grilling
Labels: wayfinder:grilling
Status: resolved
Parent: ../map.md
Blocked by: 04, 05, 06

## Question

Apply [Decide platform identity and authorization contracts](06-platform-identity.md): persistent account links and Janitor teammate status authorize senders independently of Access expiry. Define removal versus acceptance ordering, immutable accepted-input retries, and durable rejection handling so later linking or restoration never replays rejected messages. Platform signature verification is separate from human authorization.

How do Slack messages and authorized PR reviews become session inputs, and how are agent responses and changes delivered to the correct place?

Specify platform events, permissions, routing, acknowledgement, deduplication, history capture, output grouping, rate-limit behavior, and prevention of bot-message feedback loops. Preserve ordinary-message prompting after the initial mention and next-turn queuing during active work. Define PR-to-session routing, including a PR with multiple relevant sessions, and review reply behavior without prompting again in Slack. Include working state, concise tool activity, and visible failures. Do not introduce deferred GitHub-to-chat completion notifications. Identify any platform behavior requiring focused research before choosing a contract.

Honor the accepted state and delivery contract in [Decide session state ownership and recovery](04-session-durability.md). Specify source-event identities, review grouping and edits, rejection handling, and outbound reconciliation without reordering accepted instructions by platform timestamp or changing the payload under an existing admission ID.

## Comments

### First discussion round, accepted

Claimed after confirming the state, repository, and identity prerequisites are resolved. A bounded read-only fact investigation is checking official platform delivery/history/review APIs and Janitor's current webhook infrastructure. Preserve one associated Janitor session per PR; the question about multiple relevant sessions does not reopen that accepted ownership rule.

The user accepted both decisions:

1. Editing or deleting a Slack message after Janitor accepts it does not revise or cancel the accepted instruction, including queued inputs. Teammates send a new message to correct or redirect work. Do not introduce an editable queue or infer cancellation from platform deletion.
2. Show one updating working-status message per turn with concise current tool activity. Post substantive agent responses as normal thread replies and retain a visible final or failed state. Avoid a separate permanent reply for every tool operation. Exact grouping, update cadence, and delivery mechanics depend on platform facts still under investigation.

### Delivery facts

Read-only primary-source and local-code investigation completed without live platform calls. [Slack events](https://docs.slack.dev/apis/events-api/) carry globally unique event IDs and require acknowledgement within three seconds. Normalize the underlying workspace/channel/message timestamp separately from receipt IDs to avoid duplicate instructions from mention and message subscriptions. [Changed-message events](https://docs.slack.dev/reference/events/message/message_changed/) may represent metadata changes as well as human edits; do not treat them as fresh prompts.

Current [thread history documentation](https://docs.slack.dev/reference/methods/conversations.replies/) lists bot-token history scopes and pagination. Private-thread access must be verified against the actual installation; an older assumed requirement for a user history token is not supported by the current docs. Internal apps have different limits from commercially distributed non-Marketplace apps.

[Slack posting](https://docs.slack.dev/reference/methods/chat.postMessage/) supports metadata and returns a message timestamp. Matching a durable delivery identifier in metadata after a lost response is a possible reconciliation mechanism, not an exactly-once guarantee. Do not rely on undocumented client_msg_id idempotency. [Ephemeral replies](https://docs.slack.dev/reference/methods/chat.postEphemeral/) remain best effort and nonpersistent.

[GitHub webhook events](https://docs.github.com/en/webhooks/webhook-events-and-payloads) distinguish submitted reviews, inline review comments/replies, and top-level PR conversation comments. [Review comment hydration](https://docs.github.com/en/rest/pulls/reviews#list-comments-for-a-pull-request-review) supports fetching the comments in a review; deduplicate comment IDs across overlapping events without assuming delivery order. GitHub [does not automatically redeliver failed deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries); a recovery mechanism is needed before claiming durable end-to-end intake.

Current `Ingress/GitHubWebhook.ts` authenticates signatures and journals supported events before acknowledging, and `GitHub/WebhookJournal.ts` atomically inserts a delivery ID and projection outbox entry. `packages/domain/src/GitHub/WebhookEvent.ts` omits issue_comment and pull_request_review_comment; current ingress drops unsupported event names. The review schema lacks inline-comment hydration. Existing receipt deduplication does not provide feedback-level deduplication.

### GitHub discussion round, accepted

Recommend treating a submitted review body and its inline comments as one input, with later published inline replies as new inputs and no duplicate processing through overlapping event types. Recommend applying accepted-input immutability to GitHub edits/deletions as well as Slack.

The user accepted requiring an explicit Janitor mention for top-level PR conversation comments, while submitted reviews and inline review replies from authorized teammates remain automatic. They also accepted grouping submitted reviews and immutable accepted feedback as proposed above.

### Failure behavior discussion round, accepted

The user accepted both recommendations:

1. When joining an existing Slack thread, retry temporary history-fetch failures before starting agent work. If the preceding discussion cannot be retrieved, explain the missing context and ask the teammate to summarize or provide it. Do not silently start with an incomplete history or claim deleted/unavailable messages were captured.
2. If Janitor loses access to an established home thread, preserve accepted work and queued inputs and let already accepted work continue subject to normal repository and recovery rules. Retain undelivered Slack responses, expose the delivery problem in the dashboard, and resume delivery when access returns. GitHub review handling can continue if its access remains available. Do not move the session into a different channel or DM automatically. Uncertain external operations still follow the existing stop-and-reconcile contract.

## Answer

### Intake and authorization

Janitor authenticates platform requests, durably journals receipt, and acknowledges transport before running the agent or fetching history. Reuse the GitHub journal/outbox pattern and add the missing comment event schemas. Transport receipt is not authorization, runner admission, or completion. Slack receipt deduplication uses event_id; GitHub uses delivery ID. Preserve rejected outcomes so retries cannot acquire authority after a later account connection or restoration.

Normalize Slack instructions by workspace, channel, and message timestamp, independently of envelope IDs. This prevents a mention and ordinary-message subscription from admitting the same message twice. Match authors through the persistent account-link contract; ignore bot/app-authored messages and Janitor's own output. Ordinary authorized human messages in an established private home thread are inputs without repeated mentions. Outside that thread, an authorized mention starts or attaches the session using the existing repository-selection rules.

Authorize and accept inputs in Janitor's durable per-session order across Slack and GitHub. Record source identity, original payload, author, target session, and stable runner message ID with the outbound intent. Retry admission with the same ID and payload; never backdate acceptance using platform timestamps. A removal racing acceptance follows the identity contract. Edits and deletions do not replace or cancel accepted inputs; teammates send a new instruction to correct them. Edit/delete notifications are not fresh prompts.

### Starting a Slack session

Use one stable workspace/channel/root-thread mapping per session. For a mention in an existing thread, retrieve paginated preceding discussion through the initiating message boundary. Freeze that context before starting the first agent turn. History is attributed context, not a batch of replayed instructions; it does not grant authors authority. Buffer new live messages during initialization and normalize them against the history boundary so the initiating message and later inputs are not duplicated.

For a channel-level mention, establish the home thread on that initiating message. Read no unrelated channel history. Temporary history failures retry automatically; unavailable history blocks starting the agent until Janitor explains the missing context and a teammate supplies it. Do not claim a complete record of deleted or inaccessible messages.

### GitHub review inputs and replies

Route by the associated repository and PR identity to its one Janitor session. Do not create a competing session from a review event. Unassociated PR feedback does not independently create a session in this MVP.

Subscribe to submitted reviews, published inline comments/replies, and top-level PR conversation comments. Submitted reviews contribute one input containing the review body and its inline comments. Hydrate the review's comments before admission and durably associate their IDs with that input. Standalone published inline feedback and later inline replies become new inputs. Normalize comment IDs across webhook types and review hydration; do not rely on webhook arrival order or an arbitrary debounce interval. Empty review-state changes alone need not initiate an agent turn.

Reviews and inline replies from authorized teammates are automatic inputs. Top-level PR conversation comments require an explicit Janitor mention and must actually belong to a PR, not an ordinary issue. Outside-contributor feedback remains context until an authorized teammate asks Janitor to address it. Agent-authored comments cannot prompt the agent again. Accepted GitHub feedback remains immutable after edit or deletion.

Reply to inline feedback in its GitHub review thread where possible; use the PR conversation for overall review results or clarification. Preserve source IDs and links for attribution and reconciliation. GitHub-triggered progress and completion stay on GitHub, without Slack completion notifications. A missing/deleted reply target must not silently redirect output to Slack.

### Slack output and delivery failures

For Slack-origin work, maintain one updating status message per turn containing concise working/tool activity, with a visible final or failed state. Deliver substantive agent responses as normal thread replies. Coalesce intermediate status updates, preserving final states and substantive responses. Rate-limit scheduling operates across sessions sharing a channel and honors platform retry guidance; token-by-token messages and a permanent reply for each tool operation are not required.

Derive output intents from durable runner events, recording the event cursor and intent atomically. Persist destination, logical output ID, payload, and returned platform message ID. Retry known-safe failures; reconcile ambiguous sends before creating another message. Slack message metadata plus thread lookup is the candidate reconciliation path, subject to verification. GitHub reply reconciliation likewise requires a durable operation identity and observable posted result. Do not claim exactly-once publication from receipt deduplication.

If a result remains uncertain, stop the affected delivery and dependent work under the existing recovery contract and expose the problem. Temporary rate limits retain pending output rather than failing the agent task. Terminal delivery failures remain visible in the dashboard and in the originating thread when posting is possible. Ephemeral onboarding guidance remains best effort; account state remains visible in Janitor.

Loss of home-thread access does not cancel accepted work. Preserve pending replies and report the delivery problem in Janitor; resume delivery on access restoration without moving the conversation to another channel or DM. GitHub handling continues when its access is available. Distinguish execution outcome from delivery outcome in the dashboard.

### Recovery and verification boundary

Use durable retries after receipt. GitHub does not automatically redeliver failed webhook requests, so include a scheduled failed-delivery reconciliation path with durable scan progress. Recovered events pass through the same deduplication and current authorization checks, while previously accepted retries retain their outcome. Do not infer that arbitrary historical platform messages were accepted during an outage or replay rejected requests during catch-up.

The concrete review/comment overlap algorithm, missed-event recovery coverage, required installation scopes, and ambiguous-send reconciliation need a focused integration verification before spec readiness. [Verify Slack and GitHub delivery integration](14-platform-delivery-verification.md) owns these checks and records any remaining technical choices. No live Slack or GitHub integration was exercised here; failed assumptions must return to this decision rather than silently change its behavior.

### Verification refinement

The user requested proceeding after the delivery experiments and confirmed ephemeral visibility. The [verification resolution](14-platform-delivery-verification.md#answer) refines this contract with first-successfully-captured feedback, explicit incomplete hydration, five-minute resumable recovery scans, and bounded history coverage. These constraints supersede any reading of the earlier contract as a guarantee of historical snapshots or lossless outage recovery. Live private-channel removal/restoration remains an implementation acceptance check.
