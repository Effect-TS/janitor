import { readFileSync } from "node:fs"
import { assert, describe, it, layer } from "@effect/vitest"
import { PolicyVersionId } from "@janitor/domain/Labeling/Policy/Configuration"
import { snapshotFacts } from "@janitor/domain/Labeling/Policy/Facts"
import type { Condition } from "@janitor/domain/Labeling/Policy/Condition"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/sql/SqlClient"
import {
  AiClassifier,
  AiConsentService,
  ClassifierProvider,
  decisionOutcome,
  packRequests,
  type ClassifyInput,
} from "../../src/Labeling/Classifier.ts"
import { MigratedPostgresLayer, runScript } from "../support/Postgres.ts"
import {
  actor,
  answer,
  github,
  insufficient,
  LabelingLayer,
  queryText,
  repositoryId,
  seed,
} from "./support.ts"

describe("Jev decision outcomes", () => {
  it("maps probabilities to outcomes, reason codes and reasons", () => {
    assert.deepStrictEqual(decisionOutcome(insufficient, 0.8), {
      outcome: "unknown",
      reasonCode: "insufficient-evidence",
      reason: "Insufficient evidence: matches 0.50 · evidence sufficient 0.10",
    })
    assert.deepStrictEqual(decisionOutcome({ matches: 0.8, sufficient: 0.5 }, 0.8), {
      outcome: "match",
      reasonCode: undefined,
      reason: "matches 0.80 · evidence sufficient 0.50",
    })
    assert.deepStrictEqual(decisionOutcome({ matches: 0.62, sufficient: 0.9 }, 0.8), {
      outcome: "no-match",
      reasonCode: "low-confidence",
      reason: "confidence 0.62 below 0.8: matches 0.62 · evidence sufficient 0.90",
    })
    assert.deepStrictEqual(decisionOutcome({ matches: 0.1, sufficient: 0.9 }, 0.8), {
      outcome: "no-match",
      reasonCode: undefined,
      reason: "matches 0.10 · evidence sufficient 0.90",
    })
    // A threshold below one half still matches on the likelier side.
    assert.strictEqual(decisionOutcome({ matches: 0.4, sufficient: 0.9 }, 0.3).outcome, "match")
  })

  it("packs rules in order into requests under the byte limit", () => {
    assert.deepStrictEqual(
      packRequests([30, 30, 30, 50, 10], (size) => size, 80),
      [[30, 30], [30, 50], [10]],
    )
    // A rule larger than the limit still gets a request of its own.
    assert.deepStrictEqual(
      packRequests([90, 10], (size) => size, 80),
      [[90], [10]],
    )
    assert.deepStrictEqual(
      packRequests([], (size: number) => size),
      [],
    )
  })
})

/** Records each request's rule count; answers by title as in the classifier tests. */
let requests: Array<number> = []
const Jev = Layer.succeed(ClassifierProvider, {
  identity: { provider: "openrouter", model: "typesafe/jev-1.13" },
  decide: (queries) =>
    Effect.sync(() => {
      requests.push(queries.length)
      return queries.map((query) => answer(queryText(query).includes("Change 5")))
    }),
})

const Services = LabelingLayer.pipe(
  Layer.provide(github.layer),
  Layer.provideMerge(AiClassifier.layer),
  Layer.provideMerge(AiConsentService.layer),
  Layer.provideMerge(Jev),
  Layer.provideMerge(MigratedPostgresLayer),
)

const snapshot = (title: string, body: string | null = null) =>
  snapshotFacts({
    kind: "pull_request",
    title,
    body,
    authorLogin: "octocat",
    state: "open",
    labels: [],
    pullRequest: { baseRef: "main", draft: false, headSha: "a".repeat(40) },
  })

const input = (
  prompt: string,
  facts = snapshot("Change 5"),
  options: {
    readonly evidence?: ReadonlyArray<"title" | "body">
    readonly appliesWhen?: Condition
    readonly number?: number
  } = {},
): ClassifyInput => {
  const evaluator = {
    _tag: "Classifier" as const,
    prompt,
    evidence: (options.evidence ?? ["title"]) as readonly ["title" | "body"],
    minimumConfidence: 0.8,
  }
  return {
    repositoryId,
    number: options.number ?? 5,
    policyVersionId: PolicyVersionId.make("draft"),
    program: { target: "pull_request", appliesWhen: options.appliesWhen ?? null, evaluator },
    evaluator,
    snapshot: facts,
    resolve: () => undefined,
  }
}

layer(Services, { timeout: "2 minutes" })("Jev decisions against Postgres", (it) => {
  it.effect("sends an item's uncached AI rules in one request and keeps input order", () =>
    Effect.gen(function* () {
      yield* seed
      yield* (yield* AiConsentService).set(repositoryId, true, actor)
      const classifier = yield* AiClassifier
      const cachedRule = input("Batch cached {{fact:title}}")
      yield* classifier.classify(cachedRule)
      requests = []
      const results = yield* classifier.classifyMany([
        input("Batch one {{fact:title}}"),
        input("Batch outside {{fact:title}}", snapshot("Change 5"), {
          appliesWhen: {
            _tag: "Fact",
            fact: "title",
            operator: "equals",
            caseSensitive: false,
            value: "something else",
          },
        }),
        cachedRule,
        input("Batch two {{fact:title}}", snapshot("Change 6")),
        input(
          "Batch body {{fact:body}}",
          { kind: "pull_request", facts: {} },
          {
            evidence: ["body"],
          },
        ),
        input("Batch three {{fact:title}}"),
      ])
      assert.deepStrictEqual(requests, [3])
      assert.deepStrictEqual(
        results.map((result) => [result.outcome, result.cached ?? null]),
        [
          ["match", false],
          ["not-applicable", null],
          ["match", true],
          ["no-match", false],
          ["unknown", null],
          ["match", false],
        ],
      )
      assert.strictEqual(results[4]?.reasonCode, "missing-evidence")
      assert.deepStrictEqual(results[0]?.probabilities, { matches: 0.95, sufficient: 0.95 })
      const recorded = yield* (yield* SqlClient.SqlClient)<{
        probabilities: unknown
      }>`SELECT probabilities FROM labeling_ai_decision WHERE repository_id=${repositoryId} AND reason LIKE 'matches 0.95%' LIMIT 1`
      assert.deepStrictEqual(recorded[0]?.probabilities, { matches: 0.95, sufficient: 0.95 })
      // Cached answers carry the probabilities they were recorded with.
      const again = yield* classifier.classify(input("Batch one {{fact:title}}"))
      assert.strictEqual(again.cached, true)
      assert.deepStrictEqual(again.probabilities, { matches: 0.95, sufficient: 0.95 })
    }),
  )

  it.effect("splits rules whose inputs exceed one request across several", () =>
    Effect.gen(function* () {
      yield* seed
      yield* (yield* AiConsentService).set(repositoryId, true, actor)
      const classifier = yield* AiClassifier
      requests = []
      const body = "Paragraph of evidence.\n".repeat(2000)
      const results = yield* classifier.classifyMany(
        Array.from({ length: 6 }, (_, i) =>
          input(`Split ${i} {{fact:title}} {{fact:body}}`, snapshot("Change 5", body), {
            evidence: ["title", "body"],
          }),
        ),
      )
      assert.isAbove(requests.length, 1)
      assert.strictEqual(
        requests.reduce((sum, size) => sum + size, 0),
        6,
      )
      assert.isTrue(results.every((result) => result.outcome === "match"))
    }),
  )

  it.effect("carries consent given for the chat model over to Jev", () =>
    Effect.gen(function* () {
      yield* seed
      const sql = yield* SqlClient.SqlClient
      const consent = yield* AiConsentService
      yield* consent.set(repositoryId, true, actor)
      // Recreate the pre-0055 state: consent recorded for the chat model, no probabilities.
      yield* runScript(
        sql,
        `
        UPDATE labeling_ai_consent SET provider = 'openai', model = 'gpt-5.6-luna';
        ALTER TABLE labeling_ai_decision DROP COLUMN probabilities;
      `,
      )
      const classifier = yield* AiClassifier
      const before = yield* classifier.classify(input("Consent {{fact:title}}"))
      assert.strictEqual(before.outcome, "unknown")
      assert.include(before.reason, "AI provider changed")
      yield* runScript(
        sql,
        readFileSync(new URL("../../migrations/0055_jev_decisions.sql", import.meta.url), "utf8"),
      )
      const migrated = yield* consent.get(repositoryId)
      assert.deepStrictEqual(
        [migrated.state, migrated.provider, migrated.model],
        ["enabled", "openrouter", "typesafe/jev-1.13"],
      )
      const after = yield* classifier.classify(input("Consent {{fact:title}}"))
      assert.strictEqual(after.outcome, "match")
    }),
  )
})
