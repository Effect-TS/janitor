# Dry-run candidate: quoted review invocation

Use the [verified bug report](issues/01-quoted-mention.md) as a candidate GitHub issue for testing Janitor's review workflow against its own repository.

The expected behavior is already specified by ADR 0007. The task for Janitor is to investigate and produce a minimal failing reproduction test, without fixing production code. Keep repository dry-run enabled for the first invocation.

The local [reproduction test](reproduction.test.ts.txt) contains the failing case and two controls. To run it, temporarily copy it to `packages/domain/test/Review/Invocation.dry-run.test.ts`, run `vp test packages/domain/test/Review/Invocation.dry-run.test.ts`, and remove the temporary copy afterward. The observed result was one failed assertion and two passing tests, in 247 ms overall. Existing tests were not changed.

Suggested new GitHub issue comment after publishing the report:

```text
/janitor Please investigate whether the quoted-mention behavior described here still occurs on the default branch. Try to demonstrate it with a minimal failing test. Do not fix production code.
```

Published as [GitHub issue #78](https://github.com/Effect-TS/janitor/issues/78). No review invocation has been posted. The issue body alone will not invoke Janitor; an authorized human must post a new comment containing the slash command.

Validation after removing the temporary failing test: `vp check` passed with 0 errors and 347 existing warnings; `vp test` passed all 794 tests across 126 files.
