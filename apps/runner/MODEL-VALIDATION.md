# Deployment model validation

## Candidate and evidence

`model-configurations/openrouter-llama-3.1-8b.json` selects OpenRouter's `meta-llama/llama-3.1-8b-instruct` through the pinned SDK's native OpenRouter route. It is a small open-weight candidate for the preference for inexpensive models. Account access, current price and repository-task quality still need acceptance. No personal subscription or labeling client participates.

Primary provider documentation checked on 2026-09-13:

| Contract                                                             | Evidence                                                                                                       |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Model identity, text modalities and per-provider limits/capabilities | [OpenRouter endpoint metadata](https://openrouter.ai/api/v1/models/meta-llama/llama-3.1-8b-instruct/endpoints) |
| Endpoint and bearer authentication                                   | [OpenRouter quickstart](https://openrouter.ai/docs/quickstart)                                                 |
| Provider pinning and disabled fallback                               | [OpenRouter provider selection](https://openrouter.ai/docs/guides/routing/provider-selection)                  |

The record pins the Groq upstream through OpenRouter with `only: ["groq"]`, `allow_fallbacks: false` and `require_parameters: true`. The endpoint metadata reports 131,072 context tokens, 117,964 maximum completion tokens and tool support for that upstream. Other upstreams have different limits; changing upstream requires a new configuration ID. Authentication and billing go through OpenRouter; no Groq key is required. The original direct-Groq record remains available unchanged.

The pinned SDK's OpenRouter serializer inherits OpenAI-specific request fields. The runner adapts its serialized body to send `max_tokens` and omit `store` and `prompt_cache_key`, which the selected endpoint does not advertise. Strict parameter matching remains enabled. The HTTP transport test checks the actual outgoing body for initial turns, tool continuations and local compaction.

Provider documentation establishes advertised support. It does not prove the pinned native transport works with the account or model. The live check is still a release prerequisite.

## Limits and compaction

The record contains provider limits, not smaller fixture limits. Context includes both prompt and output; the two maxima cannot be consumed independently in one request. The record sets `generation.maxTokens` to 2,048, which the native route sends as `max_completion_tokens`. Provider limits alone do not set a generation cap. OpenCode 2.0.2 local compaction reserves the larger of the output limit capped at 32,000 and the default 20,000-token buffer. For this record the estimated prompt threshold is 99,072 tokens.

`compaction.mode` is `local`. OpenCode requests a summary from the same resolved session model and retains recent conversation within its native 15,000-token retention policy. Older messages remain in durable history. A summary can omit detail; retention does not mean every old tool result is resent verbatim. The summary's recent-history representation truncates individual tool outputs at 2,000 characters. Compaction usage is recorded separately by the native runner and included in cumulative usage.

These details come from the installed `@opencode/core` 2.0.2 implementation, particularly `SessionCompaction` and generation options. Recheck them when upgrading the pinned SDK. Do not lower advertised model limits to make a smoke test trigger compaction.

## Credentials and activation

Use a team-owned OpenRouter API credential. Supply its value only as the runner secret binding `JANITOR_AGENT_RUNNER_MODEL_API_KEY`. Store the JSON configuration as `JANITOR_AGENT_RUNNER_MODEL_CONFIGURATIONS`. Do not put the key in that JSON, command arguments, repository files, Slack, CI output, container environment, or checkpoint configuration. The runner resolves the binding into a bearer header at request time.

The runner snapshots the selected record before host construction and blocks changed or removed records before recovery. Sessions created by older releases establish their snapshot on first activation of this release. Preserve their original records during that activation; the runner cannot reconstruct metadata that earlier releases did not save.

Keep each model record unchanged once a session references it. To change the default, append a record with a new ID, retain old records, and change `default`. Existing sessions must continue resolving their original record. If a provider permanently retires that model, preserve the session and its workspace for inspection and start a new session. Never map its old configuration ID onto a replacement model.

To rotate a key, provision a replacement for the same secret binding and activate a compatible runner version. Keep the old provider credential valid until old runtimes have stopped and a resumed session has succeeded with the new credential. Then revoke the old credential at the provider. A failed activation or authentication check must preserve work. Coordinate rotation with the maintenance procedure in [README.md](README.md#controlled-upgrades) when a quiescent cutover is required.

## Acceptance evidence

Controlled tests must use the runner command boundary and native model HTTP boundary. Existing `Transport.test.ts` covers first-response inactivity, mid-stream inactivity, disconnects, slow active streams, transient retries and retry exhaustion. `Conversation.test.ts` covers missing credentials and cumulative usage. Repository acceptance tests cover exclusion of runtime secrets from repository execution and checkpoints.

`ModelDeployment.test.ts` covers record mutation and retirement, default changes, rotation across runtime replacement, HTTP 401/403/404 failures, redaction, output settings, and native local compaction with two successful fragmented tool calls. Its forced high usage is controlled evidence only; the deployment record keeps the real limits.

Credential redaction covers both HTTP error bodies and decoded native stream events. It holds potential credential prefixes between text, reasoning and tool-argument deltas, and sanitizes final parsed tool inputs before execution. A native write/read test verifies that a fragmented provider echo cannot write the credential into a repository file. The pinned runner uses streaming for turns and local compaction; any future use of the separate native `generate` method must apply the same redaction.

`ModelProvider.live.test.ts` first runs the complete bounded driver with controlled responses through the production FetchHttpClient, native route/resolver, Workerd session, disposable repository, real bridge and R2 checkpoints. It checks usage normalization against independent HTTP usage fields, successful tool results and continuation after native manual compaction. Its second test uses the real provider only when explicitly enabled.

From `apps/runner/`, run:

```sh
vp install
vp run typecheck
vp run test test/ModelDeployment.test.ts test/ModelProvider.live.test.ts test/Transport.test.ts
vp run build
```

## Bounded live check

No live-provider pass has been recorded. A team credential with model access and explicit authorization for a bounded paid run are prerequisites. Provider availability and price depend on the account. Do not count the controlled pass as live evidence.

After authorization, supply `JANITOR_AGENT_RUNNER_MODEL_API_KEY` in the process environment through your secret manager. Do not paste the key into a command or repository file. Then run from `apps/runner/`:

```sh
JANITOR_ALLOW_MODEL_SMOKE=openrouter-llama-3.1-8b-v1 \
JANITOR_MODEL_SMOKE_REPORT=/tmp/janitor-model-smoke.json \
vp run test test/ModelProvider.live.test.ts
```

The driver permits at most eight outbound provider requests, including native retries and compaction, each with exactly 2,048 maximum output tokens and at most 131,072 UTF-8 request bytes. It aborts outbound work after three minutes. Requested output is bounded by 16,384 tokens and total request bodies by 1 MiB. These are validation ceilings, not a monetary quote or a product budget. It refuses other endpoints/models and never rewrites the native request to make it pass.

The disposable repository contains two validation files. The model reads both with native tools, reports their codes, compacts through its pinned model, then answers from retained history. The test requires a response containing multiple tool calls and observed incremental argument fragments. It fails if the provider omits usage or required tool behavior, rejects access, or exceeds a ceiling. Inspect the credential-free report before deciding whether another bounded run is warranted; no automatic reruns are authorized.

The report records only configuration identity, time, pass/fail, request counts, statuses, argument-fragment counts and numeric usage. Cleanup aborts provider work, disposes the local runner and removes containers. This check does not deploy Cloudflare resources or prove a production secret cutover. Rotation activation is checked separately with controlled credentials.
