import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { GitHubLabelDatabaseId } from "@janitor/domain/GitHub/Id"
import {
  CreatePolicyRequest,
  SavePolicyRequest,
  ValidatePolicyRequest,
} from "@janitor/domain/Labeling/Policy/Configuration"
import {
  Condition,
  conditionFacts,
  ConditionSource,
  PolicyId,
  type PolicyNames,
} from "@janitor/domain/Labeling/Policy/Condition"
import {
  Program,
  ProgramFromSource,
  ProgramSource,
  programToSource,
} from "@janitor/domain/Labeling/Policy/Program"

const ready = PolicyId.make("policy-ready")
const names: PolicyNames = {
  resolve: (name) => (name === "ready" ? ready : undefined),
  format: (id) => (id === ready ? "ready" : id),
}

describe("Condition", () => {
  it.effect(
    "rejects misspelled scope and ambiguous authoring keys instead of discarding them",
    () =>
      Effect.gen(function* () {
        const predicate = { fact: "title", operator: "contains", value: "fix" }
        const invalid = [
          { target: "pull_request", matchesWhen: predicate, applieswhen: predicate },
          {
            target: "pull_request",
            matchesWhen: predicate,
            classify: { prompt: "Is this a fix?", evidence: ["title"] },
          },
          {
            target: "pull_request",
            matchesWhen: { all: [{ ...predicate, policy: "ready" }] },
          },
          {
            target: "pull_request",
            matchesWhen: {
              some: "changedFiles",
              where: { fact: "path", operator: "contains", value: "src", caseSensitve: true },
            },
          },
        ]
        for (const source of invalid) {
          const failure = yield* Effect.flip(Schema.decodeUnknownEffect(ProgramSource)(source))
          assert.strictEqual(failure._tag, "SchemaError")
          const create = yield* Effect.flip(
            Schema.decodeUnknownEffect(CreatePolicyRequest)({ name: "Fixes", source }),
          )
          assert.strictEqual(create._tag, "SchemaError")
          const save = yield* Effect.flip(
            Schema.decodeUnknownEffect(SavePolicyRequest)({ version: 1, source }),
          )
          assert.strictEqual(save._tag, "SchemaError")
          const validate = yield* Effect.flip(
            Schema.decodeUnknownEffect(ValidatePolicyRequest)({ source }),
          )
          assert.strictEqual(validate._tag, "SchemaError")
        }
        const failure = yield* Effect.flip(
          Schema.decodeEffect(ConditionSource)({ ...predicate, policy: "ready" }),
        )
        assert.strictEqual(failure._tag, "SchemaError")
      }),
  )

  it.effect("decodes fact predicates typed by the catalog and rejects mismatched operators", () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknownEffect(Condition)({
        _tag: "All",
        conditions: [
          { _tag: "Fact", fact: "baseRef", operator: "equals", value: "main" },
          { _tag: "Fact", fact: "draft", operator: "is", value: false },
          { _tag: "Fact", fact: "labels", operator: "has", value: "11" },
          {
            _tag: "Collection",
            fact: "changedFiles",
            quantifier: "some",
            where: {
              _tag: "Fact",
              fact: "path",
              operator: "matchesGlob",
              value: ".changeset/*.md",
            },
          },
        ],
      })
      assert.strictEqual(decoded._tag, "All")
      // The default is filled in, so callers never branch on its absence.
      assert.deepStrictEqual(conditionFacts(decoded), [
        "baseRef",
        "draft",
        "labels",
        "changedFiles",
      ])
      const first = decoded._tag === "All" ? decoded.conditions[0] : undefined
      assert.strictEqual(
        first?._tag === "Fact" && "caseSensitive" in first ? first.caseSensitive : null,
        false,
      )

      const bad = yield* Effect.flip(
        Schema.decodeUnknownEffect(Condition)({
          _tag: "Fact",
          fact: "draft",
          operator: "contains",
          value: "x",
        }),
      )
      assert.strictEqual(bad._tag, "SchemaError")
      const badItem = yield* Effect.flip(
        Schema.decodeUnknownEffect(Condition)({
          _tag: "Collection",
          fact: "changedFiles",
          quantifier: "every",
          where: { _tag: "Fact", fact: "reviewer", operator: "equals", value: "x" },
        }),
      )
      assert.strictEqual(badItem._tag, "SchemaError")
    }),
  )

  it.effect("round-trips the authoring form through the runtime form", () =>
    Effect.gen(function* () {
      const source = {
        target: "pull_request",
        appliesWhen: {
          not: { fact: "title", operator: "matchesGlob", value: "Version Packages*" },
        },
        matchesWhen: {
          all: [
            { fact: "draft", operator: "is", value: false },
            { any: [{ policy: "ready" }, { fact: "labels", operator: "has", value: "11" }] },
            {
              none: "reviews",
              where: { fact: "state", operator: "equals", value: "CHANGES_REQUESTED" },
            },
          ],
        },
      }
      const program = yield* Schema.decodeUnknownEffect(ProgramFromSource(names))(source)
      assert.deepStrictEqual(
        program.evaluator._tag === "Conditions" ? program.evaluator.matchesWhen : null,
        {
          _tag: "All",
          conditions: [
            { _tag: "Fact", fact: "draft", operator: "is", value: false },
            {
              _tag: "Any",
              conditions: [
                { _tag: "Policy", policyId: ready },
                {
                  _tag: "Fact",
                  fact: "labels",
                  operator: "has",
                  value: GitHubLabelDatabaseId.make("11"),
                },
              ],
            },
            {
              _tag: "Collection",
              fact: "reviews",
              quantifier: "none",
              where: {
                _tag: "Fact",
                fact: "state",
                operator: "equals",
                value: "CHANGES_REQUESTED",
                caseSensitive: false,
              },
            },
          ],
        },
      )
      const encoded = yield* Schema.encodeEffect(ProgramFromSource(names))(program)
      assert.deepStrictEqual(encoded, programToSource(program, names))
      assert.deepStrictEqual(
        (encoded as { matchesWhen: { all: Array<unknown> } }).matchesWhen.all[1],
        {
          any: [{ policy: "ready" }, { fact: "labels", operator: "has", value: "11" }],
        },
      )
      // The runtime program decodes on its own, as stored versions must.
      const stored = yield* Schema.decodeUnknownEffect(Program)(
        JSON.parse(JSON.stringify(yield* Schema.encodeEffect(Program)(program))),
      )
      assert.deepStrictEqual(stored, program)
    }),
  )

  it.effect("names an unknown policy reference", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        Schema.decodeUnknownEffect(ProgramFromSource(names))({
          target: "pull_request",
          matchesWhen: { policy: "missing" },
        }),
      )
      assert.include(String(failure), "missing")
      assert.isTrue(Schema.is(ConditionSource)({ policy: "anything" }))
    }),
  )
})
