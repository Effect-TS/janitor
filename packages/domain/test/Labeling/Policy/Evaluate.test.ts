import { assert, describe, it } from "@effect/vitest"
import { GitHubLabelDatabaseId } from "@janitor/domain/GitHub/Id"
import { type Condition, PolicyId } from "@janitor/domain/Labeling/Policy/Condition"
import {
  all,
  any,
  evaluate,
  evaluateApplicability,
  matchesGlob,
  not,
} from "@janitor/domain/Labeling/Policy/Evaluate"
import { type FactSnapshot, snapshotFacts } from "@janitor/domain/Labeling/Policy/Facts"
import type { Program } from "@janitor/domain/Labeling/Policy/Program"

const bug = GitHubLabelDatabaseId.make("11")
const pr = (overrides: Partial<Parameters<typeof snapshotFacts>[0]> = {}): FactSnapshot =>
  snapshotFacts({
    kind: "pull_request",
    title: "Fix Cleanup",
    body: null,
    authorLogin: "Octocat",
    state: "open",
    labels: [],
    pullRequest: { baseRef: "main", draft: false, headSha: "a".repeat(40) },
    ...overrides,
  })
const issue = (): FactSnapshot =>
  snapshotFacts({
    kind: "issue",
    title: "Crash on start",
    body: "",
    authorLogin: "octocat",
    state: "open",
    labels: [bug],
    pullRequest: null,
  })
const program = (
  matchesWhen: Condition,
  appliesWhen: Condition | null = null,
  target: Program["target"] = "pull_request",
): Program => ({
  target,
  appliesWhen,
  evaluator: { _tag: "Conditions", matchesWhen },
})
const fact = (fact: string, operator: string, value?: unknown): Condition =>
  ({
    _tag: "Fact",
    fact,
    operator,
    ...(value === undefined ? {} : { value }),
    caseSensitive: false,
  }) as Condition
const none = () => undefined

describe("Evaluate", () => {
  it("evaluates referenced scope fully without evaluating the caller's matchesWhen", () => {
    const ready = PolicyId.make("ready")
    const input = {
      program: program(fact("body", "notEmpty"), { _tag: "Policy" as const, policyId: ready }),
      snapshot: pr(),
      resolve: () => ({ program: program(fact("draft", "is", false)) }),
    }
    assert.strictEqual(evaluateApplicability(input).outcome, "match")
    assert.strictEqual(evaluate(input).outcome, "no-match")
    assert.strictEqual(
      evaluateApplicability({
        ...input,
        resolve: () => ({ program: program(fact("draft", "is", true)) }),
      }).outcome,
      "not-applicable",
    )
    assert.strictEqual(evaluateApplicability({ ...input, resolve: none }).outcome, "unknown")
  })

  it("follows Kleene's tables", () => {
    assert.strictEqual(not("unknown"), "unknown")
    assert.strictEqual(all(["match", "unknown"]), "unknown")
    assert.strictEqual(all(["no-match", "unknown"]), "no-match")
    assert.strictEqual(any(["match", "unknown"]), "match")
    assert.strictEqual(any(["no-match", "unknown"]), "unknown")
    assert.strictEqual(all([]), "match")
    assert.strictEqual(any([]), "no-match")
  })

  it("evaluates text, flag, and label predicates with case folding", () => {
    assert.strictEqual(
      evaluate({
        program: program(fact("baseRef", "equals", "main")),
        snapshot: pr(),
        resolve: none,
      }).outcome,
      "match",
    )
    assert.strictEqual(
      evaluate({
        program: program(fact("author", "equals", "OCTOCAT")),
        snapshot: pr(),
        resolve: none,
      }).outcome,
      "match",
    )
    assert.strictEqual(
      evaluate({
        program: program({
          ...fact("title", "contains", "cleanup"),
          caseSensitive: true,
        } as Condition),
        snapshot: pr(),
        resolve: none,
      }).outcome,
      "no-match",
    )
    assert.strictEqual(
      evaluate({
        program: program(fact("title", "matchesGlob", "fix *")),
        snapshot: pr(),
        resolve: none,
      }).outcome,
      "match",
    )
    assert.strictEqual(
      evaluate({
        program: program(fact("baseRef", "in", ["main", "release"])),
        snapshot: pr(),
        resolve: none,
      }).outcome,
      "match",
    )
    assert.strictEqual(
      evaluate({ program: program(fact("body", "isEmpty")), snapshot: pr(), resolve: none })
        .outcome,
      "match",
    )
    assert.strictEqual(
      evaluate({ program: program(fact("body", "contains", "x")), snapshot: pr(), resolve: none })
        .outcome,
      "no-match",
    )
    assert.strictEqual(
      evaluate({ program: program(fact("draft", "is", true)), snapshot: pr(), resolve: none })
        .outcome,
      "no-match",
    )
    assert.strictEqual(
      evaluate({
        program: program(fact("labels", "has", bug), null, "issue"),
        snapshot: issue(),
        resolve: none,
      }).outcome,
      "match",
    )
    assert.isTrue(matchesGlob("packages/*/package.json", "packages/effect/package.json"))
    assert.isFalse(matchesGlob("a".repeat(201), "a"))
  })

  it("reports unknown for unavailable facts and not-applicable for scope", () => {
    const unknown = evaluate({
      program: program({
        _tag: "Collection",
        fact: "changedFiles",
        quantifier: "some",
        where: fact("path", "equals", "x") as never,
      }),
      snapshot: pr(),
      resolve: none,
    })
    assert.strictEqual(unknown.outcome, "unknown")
    assert.include(unknown.reason, "changedFiles is unavailable")

    const scoped = evaluate({
      program: program(fact("draft", "is", false), fact("title", "contains", "release")),
      snapshot: pr(),
      resolve: none,
    })
    assert.strictEqual(scoped.outcome, "not-applicable")
    assert.strictEqual(
      evaluate({ program: program(fact("draft", "is", false)), snapshot: issue(), resolve: none })
        .outcome,
      "not-applicable",
    )
    // An unavailable fact inside applicability is unknown, not out of scope.
    const unknownScope = evaluate({
      program: program(fact("draft", "is", false), {
        _tag: "Collection",
        fact: "checks",
        quantifier: "every",
        where: fact("state", "equals", "success") as never,
      }),
      snapshot: pr(),
      resolve: none,
    })
    assert.strictEqual(unknownScope.outcome, "unknown")
  })

  it("quantifies collections and follows policy references with a trace", () => {
    const withFiles: FactSnapshot = {
      ...pr(),
      facts: {
        ...pr().facts,
        changedFiles: {
          _tag: "Collection",
          value: [
            { path: "a.ts", status: "modified" },
            { path: ".changeset/x.md", status: "added" },
          ],
        },
      },
    }
    const some = program({
      _tag: "Collection",
      fact: "changedFiles",
      quantifier: "some",
      where: {
        _tag: "All",
        conditions: [
          fact("path", "matchesGlob", ".changeset/*.md"),
          fact("status", "equals", "added"),
        ],
      } as never,
    })
    assert.strictEqual(
      evaluate({ program: some, snapshot: withFiles, resolve: none }).outcome,
      "match",
    )
    const every = program({
      _tag: "Collection",
      fact: "changedFiles",
      quantifier: "every",
      where: fact("status", "equals", "added") as never,
    })
    assert.strictEqual(
      evaluate({ program: every, snapshot: withFiles, resolve: none }).outcome,
      "no-match",
    )
    const noneOf = program({
      _tag: "Collection",
      fact: "changedFiles",
      quantifier: "none",
      where: fact("path", "equals", "b.ts") as never,
    })
    assert.strictEqual(
      evaluate({ program: noneOf, snapshot: withFiles, resolve: none }).outcome,
      "match",
    )

    const ready = PolicyId.make("ready")
    const referenced = program(fact("draft", "is", false), fact("title", "contains", "release"))
    const result = evaluate({
      program: program({
        _tag: "All",
        conditions: [{ _tag: "Policy", policyId: ready }, fact("baseRef", "equals", "main")],
      }),
      snapshot: pr(),
      resolve: (id) => (id === ready ? { program: referenced } : undefined),
    })
    // The referenced policy does not apply, which is unknown to the caller.
    assert.strictEqual(result.outcome, "unknown")
    assert.deepStrictEqual(
      result.trace.map((entry) => [
        entry.location.path.map((segment) => segment._tag).join("/"),
        entry.outcome,
      ]),
      [
        ["Child/Policy", "no-match"],
        ["Child", "unknown"],
        ["Child", "match"],
        ["", "unknown"],
      ],
    )
    const cycle = evaluate({
      program: program({ _tag: "Policy", policyId: ready }),
      snapshot: pr(),
      resolve: () => ({ program: program({ _tag: "Policy", policyId: ready }) }),
    })
    assert.strictEqual(cycle.outcome, "unknown")
    assert.isTrue(cycle.trace.some((entry) => entry.reason.includes("cycle")))
  })
})
