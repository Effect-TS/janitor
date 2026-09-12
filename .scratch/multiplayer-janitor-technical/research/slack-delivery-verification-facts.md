# Slack delivery verification facts

Checked 2026-09-11 against Slack's official documentation. This is a documentation check for [Verify Slack and GitHub delivery integration](../issues/14-platform-delivery-verification.md). No installation, token, channel, or live Slack request was exercised. Suggested algorithms below are design inferences, not platform guarantees.

## Private-channel bot access

The current `conversations.replies` reference lists `groups:history` for bot tokens. It does not contain the older bot-only-DM restriction. It accepts the parent `ts`, returns the parent and replies, supports cursor pagination and time bounds, and exposes `include_all_metadata`. Internal customer-built apps retain Tier 3 limits; the separate commercially distributed non-Marketplace limit is one request per minute and 15 results for qualifying installations. Verify private-thread reads against the selected bot before relying on this capability. [Slack conversations.replies](https://docs.slack.dev/reference/methods/conversations.replies/)

`conversations.history` likewise lists bot `groups:history`, supports cursor/time pagination, and exposes `include_all_metadata`. Its `is_limited` flag can identify history inaccessible because of free-workspace limits. It is not an Events API delivery ledger. [Slack conversations.history](https://docs.slack.dev/reference/methods/conversations.history/)

The minimum intake subscription for ordinary private-channel replies is `message.groups`, requiring `groups:history`. It delivers ordinary message events; `app_mention` selects mentions instead. Therefore Janitor must consume `message.groups` to meet the requirement that teammates can keep replying without repeated mentions. An `app_mention` subscription may remain useful for explicit starts, but both event paths must normalize the same message identity. [Slack message.groups](https://docs.slack.dev/reference/events/message.groups/)

Suggested identity is workspace ID + channel ID + message `ts`; keep the provider event ID separately. Store an immutable admission decision once per logical message so mention overlap and transport retries cannot create new turns or reverse a rejection. This is Janitor's algorithm, not a deduplication promise from Slack.

## Metadata and ambiguous publication

The canonical scope is `metadata.message:read`, supported by bot tokens and described as reading metadata in channels the app has joined. The metadata guide's Events API paragraph labels its link `message_metadata:read`, but that link resolves to the canonical scope page. Treat that guide label as a documentation inconsistency rather than a new scope. [Slack metadata scope](https://docs.slack.dev/reference/scopes/metadata.message.read/)

The guide documents publishing `event_type` and `event_payload` and reading the payload back with `include_all_metadata=true`. For reconciliation use a nonsecret Janitor operation ID in that payload. Validate expected app identity, workspace, channel, parent thread, operation ID, and output part, rather than trusting an arbitrary message containing a matching string. [Slack message metadata](https://docs.slack.dev/messaging/message-metadata/)

Suggested reconciliation is a paginated scan of the bound thread with metadata included. A matching message is positive evidence. No reviewed source promises bounded read-after-write visibility or makes a completed negative scan proof of nonpublication. A lost response, delayed visibility, metadata removal, or message deletion can leave the result unknown. Keep that operation unresolved and prevent automatic duplicate publication when the lookup cannot establish what happened. A local fake can verify this policy, but cannot establish Slack's actual visibility delay.

Slack's `chat.postMessage` error reference explicitly permits partial success before `internal_error` or `fatal_error`. Its references to `client_msg_id` in errors do not define a contractual deduplication interval or exactly-once API. Do not infer an idempotency guarantee from those error names. [Slack chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/)

## Exhausted delivery retries and recovery coverage

Slack expects acknowledgement within three seconds. Default retries occur nearly immediately, after one minute, and after five minutes. The optional Delayed Events setting adds hourly retries for 24 hours. The Events API remains best effort. Without that setting Slack normally stops attempting events delayed more than two hours. Poor acknowledgement success can disable subscriptions, which require re-enabling through app settings. Revocation also stops delivery. [Slack Events API](https://docs.slack.dev/apis/events-api/)

A possible bounded recovery algorithm is to persist each known home thread's initialization boundary and reconcile its retained replies on a schedule. Complete every page and retain overlap with the prior scan. Feed discovered messages through the same normalization and authorization path, keeping durable accepted/rejected decisions. Never turn pre-session context into newly accepted instructions. This recovers visible missed replies in known sessions. It cannot reconstruct deleted content, old versions of edited messages, inaccessible history, or a session-start mention that Janitor never received and therefore never bound. Channel-wide historical intake would expand scope beyond the accepted home-thread contract.

A scan watermark measures what Janitor checked, not proof that no events were lost. Persist scan failures and periods of uncertain coverage. The product must choose how users learn about an unrecoverable intake gap. Backfilling retained current messages does not justify claiming complete recovery of Slack events.

## Output and private onboarding

`chat.postMessage` uses `thread_ts` to reply and requires membership for private-channel posting. Slack recommends at most 4,000 text characters, truncates beyond 40,000, and gives blocks their own limits. Posting generally allows one message per second per channel, with additional workspace limits. Schedule all sessions in the same channel together, and retain final/error parts while coalescing superseded progress. [Slack chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/)

`chat.postEphemeral` needs `chat:write` and targets one user in a channel. Delivery is not guaranteed: the user must be active and a member, messages disappear across sessions, and thread ephemerals only appear in an already active thread. Its reference advises a 4,000-byte ceiling and lists Tier 4. Event metadata is ignored because ephemerals are not persisted. A successful response therefore cannot prove the teammate saw account-linking instructions. Do not use ephemeral messages as durable publication markers or require a public fallback to prove delivery. [Slack chat.postEphemeral](https://docs.slack.dev/reference/methods/chat.postEphemeral/)

## Access loss and restoration

`member_left_channel` exposes user, channel, and workspace, with `groups:read` for private channels. Private channels may have a C-prefixed ID, so inspect conversation metadata rather than infer privacy from the ID. [Slack member_left_channel](https://docs.slack.dev/reference/events/member_left_channel/)

`group_left` has `groups:read` and describes the authenticated user leaving a private channel. This is a candidate loss signal whose delivery to the selected bot needs a live check. [Slack group_left](https://docs.slack.dev/reference/events/group_left/)

`app_uninstalled` and `tokens_revoked` require no extra scopes. Their ordering is not guaranteed. Token revocation payloads identify users, not token strings. [Slack app_uninstalled](https://docs.slack.dev/reference/events/app_uninstalled/), [Slack tokens_revoked](https://docs.slack.dev/reference/events/tokens_revoked/)

Suggested handling also treats API authorization errors as loss evidence, since a webhook signal itself can be lost. Persist pending substantive output, suspend attempts to the unavailable home thread, and prove private membership/read/write capability before restoration. Do not automatically publish elsewhere. A candidate minimal bot installation has `groups:history`, `groups:read`, `chat:write`, and `metadata.message:read`, with `app_mentions:read` only if retaining `app_mention`. Identity-linking requirements are separate. This scope set is a proposal pending the actual installation test, not an installed configuration claim.

## Still needs a live fixture

- Bot private-thread pagination and metadata payload readback with the exact granted scopes.
- Overlapping mention/message delivery and initial-thread context boundary with a real private channel.
- Lost post response followed by positive metadata reconciliation; absence remains unresolved.
- Ephemeral onboarding while active, inactive, and before a thread has replies.
- Removal/restoration signals and retained-output behavior without changing destinations.
- Actual rate-limit handling. Do not deliberately flood a shared workspace merely to force 429s; deterministic local scheduling tests can cover the handler while preserving this live limitation.
