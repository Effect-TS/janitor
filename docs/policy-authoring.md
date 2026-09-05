# Authoring policies

Edit the program as YAML. Existing policies open in YAML automatically; pasted
JSON also parses. Saving still uses the existing program API and database
representation. Comments and layout belong to the editor session and are not
stored when you save and reopen a policy.

A policy decides whether an issue or pull request matches. A rule connects that
decision to a label. Keep reusable conditions in policies; configure label
behavior in rules.

The right sidebar and policy list show publication status: **Not published**,
**Changes to publish**, or **Published · vN**. A saved draft can still have changes
to publish. An unsaved dot also appears
on the selected policy in the list. Title and description changes only need
saving; publishing applies program changes. A published version may still be
waiting for repository synchronization before it takes effect. The sidebar's
Versions section shows the published revision with the publication badge beside
its heading. The controls above it appear only when saving or publishing is available.

```yaml
target: pull_request
appliesWhen:
  fact: state
  operator: equals
  value: open
matchesWhen:
  fact: draft
  operator: is
  value: false
```

`target` and exactly one of `matchesWhen` or `classify` are required.
`appliesWhen` is optional. Use `all`, `any`, and `not` to combine conditions.
Completion offers facts and operators from the server's catalog. YAML mapping
keys must be unique; unknown program and condition keys are rejected.

## Referencing policies

Publish the referenced policy first, then use its name as a condition:

```yaml
target: pull_request
matchesWhen:
  all:
    - policy: ready-for-review
    - not:
        policy: needs-rebase
```

References can appear in `matchesWhen` or `appliesWhen`, including nested
`all`, `any`, and `not` conditions. Names resolve within the same repository,
without case sensitivity. Saved references use stable policy IDs, so renaming a
policy does not break its consumers. Names with spaces work; quote names such
as `"true"` that YAML would otherwise read as a boolean.

References use the published condition policy with the same target. Missing or
unpublished policies, classifier references, cycles, and incompatible targets
are rejected. A referenced policy outside its scope contributes `unknown`,
not `no-match`, including when used under `not`.

Publishing a new dependency version updates consumers in the next repository
configuration. Publishing validates the resulting graph and recomputes required
data tracks. Existing configuration snapshots retain their own versions.
Deletion is blocked while a rule, policy version, or configuration snapshot
still needs a policy.

## Checking a draft

- **Validate** checks the program, references, and publishing constraints.
- **Test draft** evaluates the current unsaved program against synchronized open
  items. Results appear inside the editor. Editing the source clears old
  results; closing results keeps your draft.
- **Save draft** appears only for unsaved changes and saves without activating
  the program. It disappears after saving unless newer edits remain.
- **Publish** saves, validates, and publishes. If publishing fails after saving,
  the saved draft remains available for correction.

Click the title or description, or its pencil button, to open a focused input.
The inline Save button applies that field's edit to the draft. Cancel, Escape,
or moving focus outside the editing controls discards the field's pending edit.

A test does not change labels. Results depend on the available synchronized
facts, so `unknown` means a decision is not yet available. Classifier tests can
call the configured AI provider when repository consent is enabled.

## Classifiers

Use a multiline prompt and scalar evidence facts:

```yaml
target: issue
classify:
  prompt: |
    Does this issue describe a reproducible software defect?
    Exclude feature requests and usage questions.
  evidence:
    - title
    - body
  minimumConfidence: 0.8
```

Classifiers run only after applicability is known to match. Rules using a
classifier must preserve labels on no-match. Test caching includes the prompt,
evidence, confidence threshold, and provider identity so editing a draft does
not reuse a decision from a different classifier.
