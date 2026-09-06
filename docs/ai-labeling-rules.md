# AI labeling rules

Choose **AI** in the New rule editor. Select a GitHub label and target, then write
a question using fact references such as `{{fact:title}}` and `{{fact:body}}`.
Typing `{{` opens autocomplete. Enter or Tab inserts the selected reference;
Escape dismisses it. Outside autocomplete, Tab indents in the editor.

An optional **Gate policy** limits evaluation to items matching a published condition
policy for the same target. A non-match or unknown result skips the AI call and
preserves labels. Gate references follow the published policy through the existing
configuration versioning; tests also honor unsaved gate changes. Referenced gate
policies cannot be deleted or changed into incompatible classifiers.

The server derives the evidence from these references. Unknown references,
malformed tags, target-incompatible facts, and more than eight unique facts are
rejected. `changedFiles` contains paths and statuses only. Diff and source-code
retrieval are not supported.

Save creates the rule and its internally owned classifier version atomically.
Owned classifiers do not appear in the reusable policy list. Changes to the
prompt or confidence produce an immutable version; enable-only edits do not.
Existing shared classifier policies retain their normal policy editing flow.

A confident match can add the label. No match, missing evidence, insufficient
confidence, an unavailable provider, or disabled AI access preserve labels.
The confidence percentage is model-reported, not a guarantee of accuracy.
Exclusive groups select matching rules; they do not override preserve behavior
or automatically remove old AI labels.

## API

The existing rules endpoints accept an optional `ai` definition. This extends the
existing policy-rule request format without requiring clients to migrate.

```http
POST /api/v1/repositories/:repositoryId/rules
Content-Type: application/json
```

```json
{
  "requestId": "client-generated-unique-creation-key",
  "labelId": "11",
  "ai": {
    "target": "pull_request",
    "gatePolicyId": null,
    "prompt": "Does this describe a bug?\nTitle: {{fact:title}}\nDescription: {{fact:body}}",
    "minimumConfidence": 0.8
  },
  "onNoMatch": "preserve",
  "enabled": false,
  "group": null,
  "priority": 0
}
```

An AI definition cannot be combined with a shared `policyId` or label-removal
behavior. Repeating the same creation key and fields returns the same rule;
reusing it with different fields returns a conflict. The editor generates a
creation key when it mounts. `PATCH /rules/:ruleId` requires the current `version`
and accepts an updated `ai` definition or ordinary rule fields. Rule types cannot
be changed in place. GET detail/list responses include `ai`, or null for a
policy-bound rule.

`POST /rules/validate` accepts the AI definition directly and returns derived
`references` plus source-range `diagnostics`, without evaluating it.

The test bench submits a single item to `POST /rule-tests` using the existing
`TestRequest` shape with a Draft or Policy subject. Draft classifier sources
include the evidence derived by the editor; the API validates it again. It
returns HTTP 202 with `testId`, `status`, `response`, and `message`. Poll
`GET /rule-tests/:testId` until status is `done` or `failed`. Completed responses
use the existing `TestResponse` schema and may include structured `confidence`
and `cached` fields. Tests never create label actions.

## Operational behavior

Configure the existing `OPENAI_API_KEY`, optional `OPENAI_API_URL`, and
`LABELING_AI_MODEL` settings, then enable AI access explicitly for the repository.
No credentials or consent are enabled by this change. Provider/model changes
require renewed repository consent. Saving a rule does not wait for a sync or
model call. Tests use synchronized facts and return Unknown for missing or
incomplete evidence.

Initial bounds are 4,000 prompt characters, eight unique references, a conservative
12 KB rendered UTF-8 input cap, a 1,000-token provider output cap, and a 60-second
provider timeout. Active leases limit calls to two per repository and eight
globally, with at most 100 attempts per repository per hour. Identical concurrent
requests share a cached decision when it becomes available rather than issuing
a second call. Unknown results explain exhausted budgets or incomplete work.

Test evaluation has a 120-second deadline and jobs expire after five minutes.
Browser polling ends at a terminal status or its own bounded deadline, and stale
responses cannot overwrite edited inputs. Cron removes test jobs after 24 hours
and expired request claims. Repository content purge removes test requests and
AI decision content. Provider usage logs contain token counts and model identity,
not prompts or evidence.

Apply migration `0010_ai_rules.sql` before running the new backend. It is additive
and included in the normal deployment migration path. Check/review collections
from before the migration must be refreshed before classifiers use them.
