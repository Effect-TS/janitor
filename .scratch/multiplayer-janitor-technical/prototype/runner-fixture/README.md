# Unattended runner lifecycle fixture

This disposable fixture exercises the pinned OpenCode Workerd SDK using deterministic model responses, an in-memory workspace and real Durable Object alarms. It does not call a model provider or mutate a GitHub repository. Remote repository execution remains covered by the previous fixture.

## Resource and execution plan

Use the previously authorized Cloudflare account `a5324318f7f0ddf25e7a1ba5359d1aa5`. Create one uniquely named temporary Worker with a SQLite DO class, an authenticated test endpoint and a handful of isolated session objects. No Sandbox, R2 bucket, external model or platform-message integration is required for the initial lifecycle checks. Run bounded scenarios, collect durable traces, delete object storage/alarms and delete the Worker and DO namespace afterward. Preserve the existing OAuth login.

The long-running scenario uses the accepted 30-second interval and a 180-second fake model response. Between admission and the final evidence read, the driver sends no requests to that object. Other scenarios use explicitly accelerated intervals for fault injection. Evidence reads never initialize the SDK, arm an alarm or call native execution.

The first local smoke test uses Miniflare's pinned July runtime and compatibility date `2026-07-04`. Deployed checks use `2026-09-11`. Keep that distinction in the results.

## Reproduction

Use the existing isolated OpenCode probe dependency graph at `/tmp/janitor-workerd-probe/tools/workerd-probe`, pinned to OpenCode `2df00955cb933e977427535d2505e50cbc689c69` and Effect `4.0.0-rc.112`. Copy `worker.mjs` as `runner-worker.mjs`, `bundle.mjs` as `bundle-runner.mjs`, and `probe-local.mjs` as `runner-local.mjs`. The temporary package scripts `runner-bundle` and `runner-local` run these files through `vp run --no-cache`.

The native execution service is captured through an embedding layer replacement, preserving its actual implementation. The public SDK does not expose a standalone wake/recovery API. Alarm startup initializes the real SDK host, whose native startup sweep recovers orphaned claims. This fixture intentionally tests that boundary.

This is a feasibility fixture, not a production supervisor. Acceptance cases and remaining gaps belong to the verification report and ticket.

## Additional cases and source variants

`probe-remote.mjs`, `probe-additional.mjs` and `probe-final.mjs` contain the three deployed scenario groups. Their environment inputs are `FIXTURE_URL`, `FIXTURE_SECRET_FILE` and `FIXTURE_RESULT_FILE`. The secret file contains `FIXTURE_TOKEN`; never print it or commit it. Register each driver as a script in the isolated temporary package and invoke it through `vp run`. Each driver cleans its objects in `finally`; Worker/namespace deletion and verification remain the operator's final cleanup step.

`deployed/worker.mjs` and `deployed/http-model.mjs` preserve the final deployed source variant. Copy those into the isolated build directory for that version. Top-level `worker.mjs` and `http-model.mjs` additionally include the local structured-question reproduction and the accepted ordinary-question path. The latter is controlled by the fixture's `plainQuestion` setting and was accepted as MVP behavior after the local check. `probe-question.mjs` reproduces the native form wait; `probe-plain-question.mjs` asserts that ordinary conversation can continue with the structured tool removed.

The native HTTP tests replace only HTTP responses and apply deadlines before native transport error classification. They retain the real request executor, LLM client, protocol parser and session retry implementation. Timing acceleration is explicit in the drivers. The shell-policy case captures native invocation parameters before spawning; actual process timeout and descendant cleanup evidence belongs to the earlier repository fixture.
