# Plan: policies, rules, and facts

## Status

Delivered on 2026-09-03 in six commits, `6f2dfbf` through `9b18b69`, on the `cluster` branch. Supersedes the flat predicate rule from commits `f673573` through `4cd6f71`. The synchronization design and the snapshot handoff stand as they are.

Deviations from the plan as written:

- Collection facts are fetched per entity by the entity refresh, not by repository tracks. A revision that reads them asks every open pull request to refresh, and its facts evaluate unknown until that refresh verifies. Check and review webhooks are not projected yet, so those facts refresh with the pull request and on repair.
- The classifier provider is the OpenAI-compatible client with `gpt-5.6-luna` as the default model, read from `OPENAI_API_KEY`, `OPENAI_API_URL`, and `LABELING_AI_MODEL`. Without a key every classifier evaluates unknown.
- Consent, leases, the decision cache, and draining live in the cluster app; the repair cron settles draining consent once its leases expire.
- Label mutation uses the REST label endpoints by name rather than GraphQL node ids, because the read model does not always hold node ids for entities first seen through webhooks.

## What we take from slopcop

Slopcop got five things right, and this plan builds on them.

1. A reusable, named, versioned condition program is a separate thing from the rule that binds a label to it.
2. Evaluation has more than two outcomes. "Cannot tell" is different from "no", and only "no" may remove a label.
3. Every evaluation leaves a trace, and any policy can be tested against a real entity before it is published.
4. Publishing compiles the program, and the compiler's output says what the program needs and what will re-run it.
5. Two rules that disagree resolve through an explicit group and priority, not through ordering accidents.

Slopcop also carries things we should not repeat. Facts are string literals repeated across the schema, the engine, the compiler, the AI evidence list, and the editor's completion tables. The program exists twice, as an authoring shape and a runtime shape, with hand-written converters between them. Three concurrency mechanisms coexist: policy versions, per-row rule versions, and a repository revision bumped by database triggers. AI is a second kind of rule, special-cased through the coordinator and the planner. Confidence is a float that concrete evaluation carries around at a constant `1`. Triggers are derived from webhook events, which The Janitor does not evaluate. Labels are identified by name.

## Principles

- **One catalog of facts.** Everything that needs to know what a fact is, what type it has, which entity kinds carry it, and which synchronization track qualifies it reads one table in the domain package. Predicate validity, compilation, snapshot construction, fingerprinting, editor completion, and AI evidence all derive from it.
- **One program schema.** The authoring form people type and the form the engine runs are one Effect Schema with a decoding transformation between them, not two type hierarchies.
- **Three-valued logic, stated once.** Conditions evaluate to `match`, `no-match`, or `unknown` under Kleene's tables. `unknown` is what a fact the snapshot cannot supply produces. Nothing else invents it.
- **Applicability is scope, not a condition.** A policy that does not apply to an entity is `not-applicable`, a fourth outcome that rules treat as "leave the label alone".
- **Evaluation is pure and runs on snapshots.** Facts come from the read model at a verified generation. There are no triggers, because a qualified snapshot is already the converged state and every enabled rule runs on it.
- **One fence.** The repository labeling revision, which identifies the current configuration and names reconciliations, is the only version that means "this configuration is live". Policy versions are content-addressed and immutable. Rows carry an optimistic version for editing and nothing more.
- **AI is an evaluator, not a rule kind.** A policy is applicability plus an evaluator. The evaluator is a condition program today and may be a classifier later. Rules and the planner never learn which.
- **Labels are references.** A rule points at a stable label ID that synchronization already tracks. Names are display.

## Domain model

### Facts

```
Fact = {
  name:   "title" | "body" | "author" | "state" | "labels" | "draft" | "baseRef" | "headSha" | ...
  type:   Text | Flag | LabelSet | Collection<ItemShape>
  kinds:  issue | pull_request | both
  track:  entities | pull_requests | labels | changed_files | checks | reviews
}
```

`FactCatalog` is a constant record in `packages/domain/src/Labeling/Facts.ts`. Operators are defined per type, once: text takes `equals`, `contains`, `matchesGlob`, `in`, `isEmpty`; flags take `is`; label sets take `has`, `isEmpty`; collections take a quantifier and an item condition over the item shape's own typed fields. A predicate's schema is generated from the catalog, so an operator that does not fit a fact's type fails to decode rather than failing at evaluation.

Collections such as changed files, checks, and reviews are declared in the catalog from the start with their tracks, so programs referring to them decode and compile, and the compiler reports the tracks they need. They stay unavailable, and therefore `unknown`, until those tracks exist.

### Conditions

```
Condition =
  | All   { conditions }
  | Any   { conditions }
  | Not   { condition }
  | Fact  { fact, operator, value }
  | Every | Some | None { fact: Collection, item: ItemCondition }
  | Policy { policyId }
```

Authoring form: `{ all: [...] }`, `{ any: [...] }`, `{ not: ... }`, `{ fact, operator, value }`, `{ some: fact, where: ... }`, `{ policy: "name" }`. It decodes to the runtime form through one transformation that resolves policy names to IDs against the repository's policies. Encoding runs the other way for display. There are no separate source types.

### Policies

```
Policy        = { id, repositoryId, name, target, publishedVersionId | null, version }
PolicyVersion = { id, policyId, revision, contentHash, program, manifest, createdAt }
PolicyDraft   = { policyId, program, description, version }
Program       = { target, appliesWhen: Condition | null, evaluator: Conditions { matchesWhen } }
```

Publishing compiles the draft. Compilation resolves references at their published versions, rejects cycles, enforces node and depth limits, and produces the manifest: the facts read, the tracks those facts need, and the policy versions depended on. The version is content-addressed, so republishing an identical program is a no-op. A later `Classifier` evaluator adds a variant to `Program.evaluator` and nothing else.

A policy evaluates to one of four outcomes with a trace of node locations and a short reason per node:

```
Outcome = not-applicable | match | no-match | unknown
```

### Rules

```
Rule = {
  id, repositoryId, labelId, policyId,
  onNoMatch: ensure-absent | preserve,
  group: string | null, priority: int,
  enabled, labelStatus: valid | missing, version
}
```

A rule bound to a policy whose evaluator cannot produce `no-match` safely, which is what a classifier is, must be `preserve`. That is a validation rule, not a branch in the planner.

### Configuration revision

The repository's labeling revision advances whenever a policy publishes, a rule is created, changed, enabled, disabled, or removed. Each advance snapshots enabled rules and their latest published dependencies and updates the configured and active pointers atomically. It records required tracks for subsequent synchronization, without invalidating targets or scheduling backfill. Event and sync evaluations use the latest configured revision. Queued work carrying an older revision hands off to a new identity instead of applying the old plan.

### Plan

Given outcomes for every enabled rule on one entity:

1. Rules with `match` are candidates. Within a group, the lowest priority candidate is selected and the others are demoted to `no-match`.
2. A selected rule wants its label present.
3. A `no-match` rule with `ensure-absent` wants its label absent.
4. `unknown` and `not-applicable` want nothing.
5. Per label, present beats absent. The plan lists only wants that change the snapshot.

The plan records, per rule, the outcome, trace, and reason, and per label the action and the rule that decided it. This is what the reconciliation row stores and what the page shows.

### Audit

Every policy publish and every rule write appends an entry with the Access subject, the operation, and the before and after values. Fire counts derive from evaluation records over a window.

## Persistence

New tables, replacing `labeling_ruleset_revision` and the JSON blob: `labeling_policy`, `labeling_policy_version`, `labeling_policy_draft`, `labeling_policy_dependency`, `labeling_rule`, `labeling_audit`, `labeling_rule_evaluation`, and `labeling_label_action`. `labeling_repository_rules` stays as the revision pointer and `labeling_reconciliation` stays as the per-snapshot record. The sandbox holds nothing worth migrating, so the old tables drop.

## Services

- `Policies`: list, get with draft, create, save draft, publish, validate a draft, versions, remove with in-use check.
- `LabelingRules`: list with fire counts, create, patch, enable, disable, remove, revalidate label, audit.
- `LabelingConfiguration`: load the compiled runtime configuration for a repository at a revision. One loader, used by the workflow, the test endpoint, and validation.
- `Evaluation` (domain, pure): facts from an entity view, evaluate a program, plan.
- `LabelingTest`: evaluate a draft or a published policy, or the whole configuration, against chosen open entities. Explicit, never mutating. Replaces the preview added yesterday, reusing its open-entity listing.
- Reconcile workflow: evaluate activity loads the configuration at the identity's revision, builds facts, evaluates, plans, and records. Mutation stays a later activity.

## User interface

The repository page shows two tables. Policies: name, target, published revision, referenced by how many rules, menu with edit, test, delete. Rules: label chip, policy, on-no-match, group and priority, enabled toggle, fires in 30 days, menu with edit, test, delete. Below them the revision status and the reconciliations table already there.

The policy editor is a dialog with name, target, description, and a YAML source editor. Completion and linting are generated from the fact catalog and the repository's policy names, so the editor cannot drift from the schema. Validate shows facts, required tracks, references, and node count. Test draft runs the unsaved program without closing the editor. Publish saves and publishes. See [policy-authoring.md](policy-authoring.md) for the current syntax and reference behavior.

The rule editor is a small dialog: label chips from synchronized labels, policy select, on-no-match, group, priority, enabled.

The test dialog picks open entities, runs, and shows per entity the outcome, the trace as a list of node locations with reasons, and the label changes the rule or configuration would make.

## Delivery

Each phase ships to the sandbox and is reviewed before the next.

1. **Domain.** Fact catalog, generated predicate schemas, condition and program schemas with the authoring transformation, evaluator with Kleene semantics and traces, compiler with manifest, planner. Pure tests only.
2. **Persistence and services.** Migration, `Policies`, `LabelingRules`, `LabelingConfiguration`, `LabelingTest`, routes, the evaluate activity recording per-rule outcomes. Mutation off. Postgres tests.
3. **Web.** CodeMirror dependency, policy editor with generated completion, the two tables, rule dialog, test dialog. Delete the card editor.
4. **Apply and own.** Mutation activity using node IDs, action rows marked applied, missing labels disable their rules, managed-label ownership per the design, event-driven evaluation without activation backfill.
5. **Classifier evaluator.** Prompt, evidence from the catalog, minimum confidence, consent and leases. Rules bound to it are forced to `preserve`.
6. **Collection tracks.** Changed files, checks, reviews as synchronization tracks, which makes their facts available with no domain change.

## Decisions to confirm

1. Drop yesterday's `dryRun` and `onMatch: remove`. Groups cover exclusivity and the test dialog covers dry runs.
2. Policies are edited as YAML with generated completion, not as a visual tree.
3. The uncommitted rules editor is discarded. The open-entity listing and preview service are kept and folded into `LabelingTest`.
4. The revision pointer remains the only live fence. No per-row triggers.
