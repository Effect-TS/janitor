import { assert, describe, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import { GitHubLabelDatabaseId, GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { RepositoryBlocked, RepositoryNotFound } from "@janitor/domain/GitHub/Repository"
import { PolicyId } from "@janitor/domain/Labeling/Policy/Condition"
import {
  type Actor,
  GroupConflict,
  RuleConflict,
  RuleInvalid,
  RuleNotFound,
  type RuleRecord,
} from "@janitor/domain/Labeling/Policy/Configuration"
import { RuleId } from "@janitor/domain/Labeling/Policy/Plan"
import { CurrentAccessIdentity } from "../../src/Ingress/Middleware.ts"
import { RulesGroupLayer } from "../../src/Ingress/Rules.ts"
import { LabelingConfiguration } from "../../src/Labeling/Configuration.ts"
import { LabelingRules } from "../../src/Labeling/Rules.ts"
import { makeClient } from "../support/Api.ts"

const repositoryId = GitHubRepositoryDatabaseId.make("701")
const ruleId = RuleId.make("rule-1")
const at = DateTime.makeUnsafe("2026-09-03T12:00:00.000Z")
const identity = {
  issuer: "https://team.cloudflareaccess.test",
  subject: "user-1",
  email: undefined,
  expiresAt: at,
}

const rule: RuleRecord = {
  id: ruleId,
  repositoryId,
  labelId: GitHubLabelDatabaseId.make("11"),
  policyId: PolicyId.make("policy-1"),
  onMatch: "ensure-present",
  onNoMatch: "no-action",
  group: "kind",
  priority: 10,
  enabled: true,
  labelStatus: "valid",
  version: 1,
  createdAt: at,
  updatedAt: at,
}

/** The actor each write was made as, in order. */
const actors: Array<Actor> = []
const as = (actor: Actor) => Effect.sync(() => actors.push(actor))

const stub = (overrides: Partial<LabelingRules["Service"]> = {}): LabelingRules["Service"] => ({
  list: () => Effect.succeed([rule]),
  create: (_, request, actor) => as(actor).pipe(Effect.as({ ...rule, labelId: request.labelId })),
  patch: (_, __, request, actor) =>
    as(actor).pipe(Effect.as({ ...rule, version: request.version + 1 })),
  reorder: (_, request, actor) =>
    as(actor).pipe(Effect.as([{ ...rule, priority: request.rules[0]!.priority }])),
  remove: (_, __, ___, actor) => as(actor).pipe(Effect.asVoid),
  audit: () => Effect.die("unused"),
  ...overrides,
})

const configuration = (
  requireRepository: LabelingConfiguration["Service"]["requireRepository"] = () => Effect.void,
): LabelingConfiguration["Service"] => ({
  requireRepository,
  labels: () => Effect.die("unused"),
  load: () => Effect.die("unused"),
  advance: () => Effect.die("unused"),
  view: () => Effect.die("unused"),
})

const client = (
  rules: LabelingRules["Service"],
  repositories: LabelingConfiguration["Service"] = configuration(),
) =>
  makeClient(
    ["rules"],
    RulesGroupLayer,
    Context.make(LabelingRules, rules).pipe(
      Context.add(LabelingConfiguration, repositories),
      Context.add(CurrentAccessIdentity, identity),
    ),
  )

type Client = Effect.Success<ReturnType<typeof client>>

/** Each refusal reaches the client as itself, tag and fields. */
const refuses = <E>(
  refusals: ReadonlyArray<E>,
  service: (refusal: E) => Partial<LabelingRules["Service"]>,
  call: (api: Client) => Effect.Effect<unknown, unknown>,
) =>
  Effect.forEach(refusals, (refusal) =>
    Effect.gen(function* () {
      const api = yield* client(stub(service(refusal)))
      assert.deepStrictEqual(yield* Effect.flip(call(api)), refusal)
    }),
  )

const params = { repositoryId, ruleId }
const definition = {
  target: "pull_request" as const,
  prompt: "Read {{fact:title}} and {{fact:nope}}",
  minimumConfidence: 0.8,
}
const reorder = { group: "kind", rules: [{ id: ruleId, version: 1, priority: 20 }] }

describe("rules", () => {
  it.effect("serves the rules, a rule and an AI rule inspection", () =>
    Effect.gen(function* () {
      const api = yield* client(stub())
      assert.deepStrictEqual(yield* api.rules.list({ params: { repositoryId } }), [rule])
      assert.deepStrictEqual(yield* api.rules.get({ params }), rule)
      const missing = RuleId.make("rule-2")
      assert.deepStrictEqual(
        yield* Effect.flip(api.rules.get({ params: { repositoryId, ruleId: missing } })),
        new RuleNotFound({ ruleId: missing }),
      )
      assert.deepStrictEqual(
        yield* api.rules.validate({ params: { repositoryId }, payload: definition }),
        {
          references: ["title"],
          diagnostics: [{ from: 24, to: 37, message: "Unknown fact 'nope'" }],
        },
      )
    }),
  )

  it.effect("writes as the Access identity", () =>
    Effect.gen(function* () {
      const api = yield* client(stub())
      actors.length = 0
      const created = yield* api.rules.create({
        params: { repositoryId },
        payload: { labelId: GitHubLabelDatabaseId.make("12"), policyId: rule.policyId },
      })
      assert.strictEqual(created.labelId, "12")
      const updated = yield* api.rules.update({ params, payload: { version: 1 } })
      assert.strictEqual(updated.version, 2)
      const [reordered] = yield* api.rules.reorder({ params: { repositoryId }, payload: reorder })
      assert.strictEqual(reordered?.priority, 20)
      yield* api.rules.delete({ params, query: { version: 2 } })
      const actor = { issuer: identity.issuer, subject: identity.subject }
      assert.deepStrictEqual(actors, [actor, actor, actor, actor])
    }),
  )

  it.effect("refuses with the rule's domain errors", () =>
    Effect.gen(function* () {
      const missingRepository = new RepositoryNotFound({ repositoryId })
      const disconnected = new RepositoryBlocked({ repositoryId, reason: "disconnected" })
      const missing = new RuleNotFound({ ruleId })
      const stale = new RuleConflict({ current: rule })
      const invalid = new RuleInvalid({
        issues: [{ code: "duplicate-priority", message: "Priority 10 is taken in kind" }],
      })

      yield* refuses(
        [missingRepository],
        (refusal) => ({ list: () => Effect.fail(refusal) }),
        (api) => api.rules.list({ params: { repositoryId } }),
      )
      yield* refuses(
        [missingRepository],
        (refusal) => ({ list: () => Effect.fail(refusal) }),
        (api) => api.rules.get({ params }),
      )
      yield* refuses(
        [missingRepository, disconnected, stale, invalid],
        (refusal) => ({ create: () => Effect.fail(refusal) }),
        (api) =>
          api.rules.create({
            params: { repositoryId },
            payload: { labelId: rule.labelId, policyId: rule.policyId },
          }),
      )
      yield* refuses(
        [missingRepository, disconnected, missing, stale, invalid],
        (refusal) => ({ patch: () => Effect.fail(refusal) }),
        (api) => api.rules.update({ params, payload: { version: 1, enabled: false } }),
      )
      yield* refuses(
        [missingRepository, disconnected, missing, stale],
        (refusal) => ({ remove: () => Effect.fail(refusal) }),
        (api) => api.rules.delete({ params, query: { version: 1 } }),
      )
      yield* refuses(
        [missingRepository, disconnected, invalid, new GroupConflict()],
        (refusal) => ({ reorder: () => Effect.fail(refusal) }),
        (api) => api.rules.reorder({ params: { repositoryId }, payload: reorder }),
      )

      const api = yield* client(
        stub(),
        configuration(() => Effect.fail(missingRepository)),
      )
      assert.deepStrictEqual(
        yield* Effect.flip(api.rules.validate({ params: { repositoryId }, payload: definition })),
        missingRepository,
      )
    }),
  )
})
