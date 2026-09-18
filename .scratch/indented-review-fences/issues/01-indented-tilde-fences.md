# Slash commands inside indented tilde code fences can trigger issue review

Status: ready-for-agent
Type: task

## Problem

`invokesReview` treats a command inside a tilde code fence indented by one, two, or three spaces as a direct invocation. GitHub renders the same text as a code block.

An authorized user quoting an example command can therefore start an investigation unintentionally. Normal permission checks still apply.

This is separate from #78, which concerns lazy blockquote continuation lines.

## Reproduction

The opening and closing fences below each have two leading spaces:

```text
  ~~~text
/janitor please investigate
  ~~~
```

Evaluate the production parser:

```ts
invokesReview("  ~~~text\n/janitor please investigate\n  ~~~")
// Actual: true
// Expected: false
```

The same failure occurs with one or three leading spaces. GitHub's Markdown API renders the two-space example as:

```html
<pre lang="text" class="notranslate"><code class="notranslate">/janitor please investigate
</code></pre>
```

## Location and suspected cause

`packages/domain/src/Review/Invocation.ts`, in `withoutEvidence`, only recognizes opening fences beginning at column zero. It consequently leaves the example command available to the invocation matcher.

## Acceptance criteria

- Commands inside valid tilde fences with zero to three leading spaces do not invoke review.
- An actual command after the closing fence still invokes review.
- Add regression coverage for one-, two-, and three-space indentation and retain existing parser behavior for unindented fences.

## Verification

Reproduced against the unchanged parser on main at `a51348d125ce0ea02e7ca2ea7a6303428cf97988`.

A temporary test importing the production parser, run with `vp test packages/domain/test/Review/IndentedFence.repro.test.ts`, produced **3 failed, 2 passed** in 197 ms. Each indented-fence case expected `false` and received `true`. Controls passed for an unindented fence and a command after an indented fence.

The temporary test was moved out of the test tree after verification; the bug remains unfixed for a review dry run.
