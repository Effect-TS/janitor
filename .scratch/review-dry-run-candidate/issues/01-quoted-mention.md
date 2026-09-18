# Quoted slash commands on Markdown continuation lines can invoke issue review

Status: needs-triage

The slash-command reproduction below applies to the `/janitor` invocation refactor. The same bug was originally verified before that refactor using the former user-mention syntax.

## Observed behavior

A command entirely inside a GitHub-rendered blockquote is treated as a direct issue-review invocation when the continuation line omits the `>` marker.

For example, this comment quotes a request:

```text
> Quoted request:
/janitor please investigate this bug.
```

GitHub renders both lines inside the same blockquote. However, `invokesReview` returns `true`. The review admission handler uses this function to decide whether a new comment contains an invocation, so an otherwise eligible comment from an authorized user can start a review unintentionally.

This does not bypass the separate repository or author permission checks.

## Expected behavior

Commands inside quoted text must not invoke review, including Markdown's lazy blockquote continuation lines. ADR 0007 requires a direct command outside quoted text, code, and link destinations.

An explicit command after a blank line that ends the blockquote must still invoke review:

```text
> Quoted request:

/janitor please investigate this bug.
```

## Reproduction

Add a focused test under `packages/domain/test/Review/` using the existing command test conventions:

```ts
expect(invokesReview("> Quoted request:\n/janitor please investigate this bug.")).toBe(false)
```

The current result is `true`. Run the test with `vp test <test-file-path>`.

Relevant files:

- `packages/domain/src/Review/Invocation.ts`, especially blockquote removal in `withoutEvidence`.
- `packages/domain/test/Review/Invocation.test.ts`.
- `apps/cluster/src/Review/Admission.ts`, which calls `invokesReview` before admission checks.
- `docs/adr/0007-explicit-github-invocation.md`.

## Acceptance criteria

- Quoted commands on lazy continuation lines are ignored.
- Fully marked blockquotes remain ignored.
- A direct command after a blank line ending the quote still works.
- Existing command-parser tests remain green.

## Verification

Verified locally on 2026-09-18 against default-branch commit `b9b9ac41e3d3fabb9a8265f30477583aa0d3d0cd` with the original syntax, then reverified with `/janitor` on the invocation-refactor branch. GitHub's Markdown rendering API placed the example entirely inside `<blockquote>`. A three-case test produced one relevant assertion failure and two passing controls. No live invocation was sent and no production fix was made.

Published as [GitHub issue #78](https://github.com/Effect-TS/janitor/issues/78).
