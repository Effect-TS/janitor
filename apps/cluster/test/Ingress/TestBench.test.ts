import { assert, describe, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as HttpApiError from "effect/http-api/HttpApiError"
import { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { RepositoryBlocked, RepositoryNotFound } from "@janitor/domain/GitHub/Repository"
import { PolicyId } from "@janitor/domain/Labeling/Policy/Condition"
import {
  PolicyInvalid,
  RuleTestNotFound,
  type ValidatePolicyResponse,
} from "@janitor/domain/Labeling/Policy/Configuration"
import type { RuleTestJob, TestEntity, TestRequest } from "@janitor/domain/Labeling/Policy/Test"
import { TestBenchGroupLayer } from "../../src/Ingress/TestBench.ts"
import { Policies } from "../../src/Labeling/Policies.ts"
import { RuleTestJobs } from "../../src/Labeling/RuleTestJob.ts"
import { LabelingTest } from "../../src/Labeling/Test.ts"
import { makeClient, unused } from "../support/Api.ts"

const repositoryId = GitHubRepositoryDatabaseId.make("701")
const testId = "test-1"
const details = {
  text: "sent input",
  facts: [{ name: "title" as const, json: JSON.stringify("old title") }],
}
const entity: TestEntity = {
  number: 5,
  kind: "pull_request",
  title: "Fix the build",
  authorLogin: "octocat",
  baseRef: "main",
  draft: false,
  labels: [],
  evaluation: { outcome: "match", reason: "base is main", trace: [], inputDetails: details },
  plan: null,
}
const queued: RuleTestJob = { testId, status: "queued", response: null, message: null }
const done: RuleTestJob = {
  testId,
  status: "done",
  response: { _tag: "Evaluated", entities: [entity] },
  message: null,
}

const tests = (overrides: Partial<LabelingTest["Service"]> = {}): LabelingTest["Service"] => ({
  items: () => Effect.succeed([entity]),
  run: () => Effect.succeed({ _tag: "Evaluated", entities: [entity] }),
  ...overrides,
})

/** The requests each enqueue received, in order. */
const enqueued: Array<TestRequest> = []

const jobs = (overrides: Partial<RuleTestJobs["Service"]> = {}): RuleTestJobs["Service"] => ({
  enqueue: (_, request) => Effect.sync(() => enqueued.push(request)).pipe(Effect.as(queued)),
  get: () => Effect.succeed(done),
  ...overrides,
})

const valid: ValidatePolicyResponse = {
  _tag: "Valid",
  manifest: { facts: ["baseRef"], tracks: [], references: [], nodeCount: 1, expandedNodeCount: 1 },
}

const client = (
  options: {
    readonly test?: LabelingTest["Service"]
    readonly jobs?: RuleTestJobs["Service"]
    readonly validation?: ValidatePolicyResponse
  } = {},
) =>
  makeClient(
    ["testBench"],
    TestBenchGroupLayer,
    Context.make(LabelingTest, options.test ?? tests()).pipe(
      Context.add(RuleTestJobs, options.jobs ?? jobs()),
      Context.add(Policies, {
        ...unused(Policies),
        validate: () => Effect.succeed(options.validation ?? valid),
      }),
    ),
  )

const params = { repositoryId }
const job = { repositoryId, testId }
const draft = {
  _tag: "Draft" as const,
  source: {
    target: "pull_request" as const,
    matchesWhen: {
      fact: "baseRef" as const,
      operator: "equals" as const,
      value: "main",
      caseSensitive: false,
    },
  },
}
const policy = { _tag: "Policy" as const, policyId: PolicyId.make("policy-1") }

describe("testBench", () => {
  it.effect("lists items, runs a test and serves a rule test with its input", () =>
    Effect.gen(function* () {
      const api = yield* client()
      enqueued.length = 0
      assert.deepStrictEqual(yield* api.testBench.listItems({ params }), [entity])
      assert.deepStrictEqual(
        yield* api.testBench.run({ params, payload: { subject: { _tag: "Configuration" } } }),
        { _tag: "Evaluated", entities: [entity] },
      )
      assert.deepStrictEqual(
        yield* api.testBench.startRuleTest({ params, payload: { subject: draft, numbers: [5] } }),
        queued,
      )
      assert.deepStrictEqual(enqueued, [{ subject: draft, numbers: [5] }])
      assert.deepStrictEqual(yield* api.testBench.getRuleTest({ params: job }), done)
      assert.deepStrictEqual(yield* api.testBench.getRuleTestInput({ params: job }), details)
    }),
  )

  it.effect("refuses with the test bench's errors", () =>
    Effect.gen(function* () {
      const missingRepository = new RepositoryNotFound({ repositoryId })
      const blocked = new RepositoryBlocked({ repositoryId, reason: "disconnected" })
      const missing = new RuleTestNotFound({ testId })
      const flip = (call: Effect.Effect<unknown, unknown>) => Effect.flip(call)

      const failing = yield* client({
        test: tests({
          items: () => Effect.fail(missingRepository),
          run: () => Effect.fail(missingRepository),
        }),
        jobs: jobs({ enqueue: () => Effect.fail(blocked), get: () => Effect.fail(blocked) }),
      })
      assert.deepStrictEqual(
        yield* flip(failing.testBench.listItems({ params })),
        missingRepository,
      )
      assert.deepStrictEqual(
        yield* flip(
          failing.testBench.run({ params, payload: { subject: { _tag: "Configuration" } } }),
        ),
        missingRepository,
      )
      assert.deepStrictEqual(
        yield* flip(
          failing.testBench.startRuleTest({ params, payload: { subject: policy, numbers: [5] } }),
        ),
        blocked,
      )
      assert.deepStrictEqual(yield* flip(failing.testBench.getRuleTest({ params: job })), blocked)

      // A rule test runs one item against a draft or a policy.
      const api = yield* client()
      for (const payload of [
        { subject: policy, numbers: [] },
        { subject: policy, numbers: [5, 6] },
        { subject: { _tag: "Configuration" as const }, numbers: [5] },
      ]) {
        assert.instanceOf(
          yield* flip(api.testBench.startRuleTest({ params, payload })),
          HttpApiError.BadRequest,
        )
      }

      const invalid = yield* client({
        validation: { _tag: "Invalid", message: "Fact 'nope' is unknown" },
      })
      assert.deepStrictEqual(
        yield* flip(
          invalid.testBench.startRuleTest({ params, payload: { subject: draft, numbers: [5] } }),
        ),
        new PolicyInvalid({ diagnostic: "Fact 'nope' is unknown" }),
      )

      // The job is gone, or its input snapshot expired.
      const gone = yield* client({ jobs: jobs({ get: () => Effect.succeed(null) }) })
      assert.deepStrictEqual(yield* flip(gone.testBench.getRuleTest({ params: job })), missing)
      assert.deepStrictEqual(yield* flip(gone.testBench.getRuleTestInput({ params: job })), missing)
      const compact = yield* client({ jobs: jobs({ get: () => Effect.succeed(queued) }) })
      assert.deepStrictEqual(
        yield* flip(compact.testBench.getRuleTestInput({ params: job })),
        missing,
      )
    }),
  )
})
