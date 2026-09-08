import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { compile } from "@janitor/domain/Labeling/Policy/Compile"
import { PolicyId } from "@janitor/domain/Labeling/Policy/Condition"
import { evaluate } from "@janitor/domain/Labeling/Policy/Evaluate"
import { snapshotFacts } from "@janitor/domain/Labeling/Policy/Facts"
import {
  type Program,
  ProgramFromSource,
  programToSource,
} from "@janitor/domain/Labeling/Policy/Program"
import { renderPrompt, validatePrompt } from "@janitor/domain/Labeling/Policy/Prompt"

const names = { resolve: () => undefined, format: (id: string) => id }
const snapshot = snapshotFacts({
  kind: "pull_request",
  title: "Bump deps",
  body: null,
  authorLogin: "bot",
  state: "open",
  labels: [],
  pullRequest: { baseRef: "main", draft: false, headSha: "a".repeat(40) },
})

describe("Classifier", () => {
  it.effect("authors as `classify`, defaults the confidence, and round-trips", () =>
    Effect.gen(function* () {
      const program = yield* Schema.decodeUnknownEffect(ProgramFromSource(names))({
        target: "pull_request",
        classify: { prompt: "Is {{fact:title}} a dependency bump?", evidence: ["title", "body"] },
      })
      assert.deepStrictEqual(program.evaluator, {
        _tag: "Classifier",
        prompt: "Is {{fact:title}} a dependency bump?",
        evidence: ["title", "body"],
        minimumConfidence: 0.8,
      })
      assert.deepStrictEqual(programToSource(program, names), {
        target: "pull_request",
        classify: {
          prompt: "Is {{fact:title}} a dependency bump?",
          evidence: ["title", "body"],
          minimumConfidence: 0.8,
        },
      })
      // Pure evaluation cannot answer; applicability still applies.
      assert.strictEqual(
        evaluate({ program, snapshot, resolve: () => undefined }).outcome,
        "unknown",
      )
      const scoped: Program = {
        ...program,
        appliesWhen: { _tag: "Fact", fact: "draft", operator: "is", value: true },
      }
      assert.strictEqual(
        evaluate({ program: scoped, snapshot, resolve: () => undefined }).outcome,
        "not-applicable",
      )
    }),
  )

  it("compiles evidence into the manifest and refuses to be referenced", () => {
    const classifier: Program = {
      target: "pull_request",
      appliesWhen: null,
      evaluator: {
        _tag: "Classifier",
        prompt: "x",
        evidence: ["title", "baseRef"],
        minimumConfidence: 0.5,
      },
    }
    const compiled = compile({ program: classifier, resolve: () => undefined })
    assert.deepStrictEqual(
      compiled._tag === "Compiled" ? compiled.manifest.tracks : compiled._tag,
      ["entities", "pull_requests"],
    )
    const referencing: Program = {
      target: "pull_request",
      appliesWhen: null,
      evaluator: {
        _tag: "Conditions",
        matchesWhen: { _tag: "Policy", policyId: PolicyId.make("ai") },
      },
    }
    const rejected = compile({ program: referencing, resolve: () => ({ program: classifier }) })
    assert.strictEqual(
      rejected._tag === "Rejected" ? rejected.issue.code : rejected._tag,
      "classifier-reference",
    )
    const issueOnly: Program = { ...classifier, target: "issue" }
    const mismatch = compile({ program: issueOnly, resolve: () => undefined })
    assert.strictEqual(
      mismatch._tag === "Rejected" ? mismatch.issue.code : mismatch._tag,
      "fact-kind-mismatch",
    )
  })

  it("validates and renders prompt templates over declared evidence", () => {
    assert.deepStrictEqual(validatePrompt("Title: {{fact:title}}", ["title"]), {
      _tag: "Valid",
      references: ["title"],
    })
    assert.strictEqual(validatePrompt("{{fact:nope}}", ["title"])._tag, "Invalid")
    assert.strictEqual(validatePrompt("{{fact:body}}", ["title"])._tag, "Invalid")
    assert.strictEqual(validatePrompt("{{fact: title}}", ["title"])._tag, "Invalid")
    const rendered = renderPrompt(
      "Title {{fact:title}} body {{fact:body}} into {{fact:baseRef}}",
      ["title", "body", "baseRef"],
      snapshot,
    )
    assert.deepStrictEqual(rendered, {
      text: 'Title "Bump deps" body null into "main"',
      evidence: { title: "Bump deps", body: null, baseRef: "main" },
    })
  })
})
