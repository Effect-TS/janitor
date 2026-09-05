# Policy system review

Reviewed authoring, wire schemas, compilation, reference resolution, evaluation,
classifier calls, draft testing, policy/rule mutations, publishing, configuration
snapshots, and editor state transitions.

The core separation is useful: YAML describes a policy, compilation validates
its requirements, evaluation returns a decision, and rules decide label changes.
Replacing these layers with another builder abstraction would add complexity.
The fixes share existing validation and transaction code instead.

## BLOCKERS

Resolved in this change:

- `packages/domain/src/Labeling/Policy/Condition.ts` and `Program.ts`: authoring
  schemas silently discarded unknown keys. A misspelled applicability key could
  broaden a policy. Authoring now rejects excess properties recursively.
- `apps/cluster/src/Labeling/Policies.ts` and `Rules.ts`: version checks happened
  before the mutation transaction, and a failed conditional update could still
  overwrite a draft. One repository mutation transaction now locks before reads.
- `apps/cluster/src/Labeling/Policies.ts`: publishing a dependency could invalidate
  published consumers or turn a removing rule into a classifier rule. Validation
  now checks the candidate published graph and bound rule behavior.
- `apps/cluster/src/Labeling/Configuration.ts`: stored transitive manifests could
  become stale after a dependency changed. New configurations recompute required
  tracks from their actual policy versions.
- `apps/cluster/src/Labeling/Policies.ts`: deletion did not account for historical
  policy dependencies and configuration snapshots. History references now block
  deletion rather than causing a foreign-key error or losing historical programs.
- `apps/cluster/src/Labeling/Classifier.ts`: unknown applicability could still
  reach the provider. Scope must now match before a call. Cache identity also
  includes the prompt, confidence, and provider, preventing stale draft decisions.
- `apps/web/src/components/policy-editor.ts`: stale validation could mark edited
  source valid; editing a name could enable duplicate saves; save completion
  could close over newer edits; publish failure could lose a successful create's
  identity. Request IDs and submission snapshots now protect those transitions.

## QUALITY

Resolved in this change:

- YAML parsing and formatting live in one authoring module. CodeMirror uses YAML
  syntax and shares parser diagnostics with submission validation. Storage and
  runtime program types stay unchanged.
- Completion uses catalog types, YAML scalar quoting, and published policy names.
  It handles names with spaces/hyphens and collection item operators.
- Draft tests reuse the existing test bench inside the editor. Tests and validation
  pass the current policy identity so self-references fail before publishing.
- Draft testing and publishing share backend candidate validation. Policy and rule
  mutations share one transaction boundary instead of nested savepoints.

## NICE-TO-HAVE

- Preserve YAML comments and original formatting if policies later become managed
  configuration files. That requires storing source text; today's API stores the
  parsed program and regenerates YAML on reopen.
- Add an explicit archival/retention workflow if users need to remove policies
  retained by historical configurations. Current deletion guards preserve history.
- Consolidate duplicated frontend/backend wire schemas when the two workspaces
  use the same Effect runtime. They currently use different Effect installations;
  sharing runtime schemas now would reintroduce the incompatibility documented in
  `apps/web/src/components/sync-button.ts`.

## VERDICT

The logical defects above are fixed with regression coverage. The policy engine
already supported reusable references; the editor and publishing checks now make
that support consistent. See [policy-authoring.md](policy-authoring.md) for YAML
examples, reference semantics, and draft testing.

## Verification

- 299 tests pass across 54 suites, including the Postgres integration tests.
- `vp build --config apps/web/vite.config.ts` passes.
- All changed files pass `vp fmt --check`; `vp check --no-fmt` reports no errors
  and existing warnings.
- Combined `vp check` still stops at malformed HTML in the older mockups
  `1-policy-workbench.html`, `2-policy-split-bench.html`, `3-rules-ledger.html`,
  and `4-rules-board.html`, outside the application changes.

The test containers use the available Podman socket:

```sh
DOCKER_HOST=unix:///run/user/1000/podman/podman.sock TESTCONTAINERS_RYUK_DISABLED=true vp test
```
