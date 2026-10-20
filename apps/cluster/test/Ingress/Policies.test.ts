import { assert, describe, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { RepositoryBlocked, RepositoryNotFound } from "@janitor/domain/GitHub/Repository"
import { PolicyId } from "@janitor/domain/Labeling/Policy/Condition"
import {
  type Actor,
  type PolicyDetail,
  PolicyConflict,
  PolicyHistoryRetained,
  PolicyInUse,
  PolicyInvalid,
  PolicyNameTaken,
  PolicyNotFound,
  type PolicyRecord,
} from "@janitor/domain/Labeling/Policy/Configuration"
import { CurrentAccessIdentity } from "../../src/Ingress/Middleware.ts"
import { PoliciesGroupLayer } from "../../src/Ingress/Policies.ts"
import { Policies } from "../../src/Labeling/Policies.ts"
import { makeClient } from "../support/Api.ts"

const repositoryId = GitHubRepositoryDatabaseId.make("701")
const policyId = PolicyId.make("policy-1")
const at = DateTime.makeUnsafe("2026-09-03T12:00:00.000Z")
const identity = {
  issuer: "https://team.cloudflareaccess.test",
  subject: "user-1",
  email: undefined,
  expiresAt: at,
}

const policy: PolicyRecord = {
  policyId,
  repositoryId,
  name: "Base is main",
  target: "pull_request",
  description: "",
  publishedVersionId: null,
  publishedRevision: null,
  version: 1,
  createdAt: at,
  updatedAt: at,
}
const detail: PolicyDetail = {
  policy,
  draft: {
    target: "pull_request",
    matchesWhen: { fact: "baseRef", operator: "equals", value: "main", caseSensitive: false },
  },
  draftDiffers: true,
  published: null,
}

/** The actor each write was made as, in order. */
const actors: Array<Actor> = []
const as = (actor: Actor) => Effect.sync(() => actors.push(actor))

const stub = (overrides: Partial<Policies["Service"]> = {}): Policies["Service"] => ({
  list: () => Effect.succeed([policy]),
  get: () => Effect.succeed(detail),
  versions: () => Effect.succeed([]),
  create: (_, request, actor) =>
    as(actor).pipe(Effect.as({ ...detail, policy: { ...policy, name: request.name } })),
  save: (_, __, request, actor) =>
    as(actor).pipe(Effect.as({ ...detail, policy: { ...policy, version: request.version + 1 } })),
  publish: (_, __, ___, actor) => as(actor).pipe(Effect.as(detail)),
  remove: (_, __, ___, actor) => as(actor).pipe(Effect.asVoid),
  validate: () => Effect.succeed({ _tag: "Invalid", message: "Fact 'draft' is unknown" }),
  names: () => Effect.die("unused"),
  resolver: () => Effect.die("unused"),
  ...overrides,
})

const client = (policies: Policies["Service"]) =>
  makeClient(
    ["policies"],
    PoliciesGroupLayer,
    Context.make(Policies, policies).pipe(Context.add(CurrentAccessIdentity, identity)),
  )

type Client = Effect.Success<ReturnType<typeof client>>

/** Each refusal reaches the client as itself, tag and fields. */
const refuses = <E>(
  refusals: ReadonlyArray<E>,
  service: (refusal: E) => Partial<Policies["Service"]>,
  call: (api: Client) => Effect.Effect<unknown, unknown>,
) =>
  Effect.forEach(refusals, (refusal) =>
    Effect.gen(function* () {
      const api = yield* client(stub(service(refusal)))
      assert.deepStrictEqual(yield* Effect.flip(call(api)), refusal)
    }),
  )

const params = { repositoryId, policyId }

describe("policies", () => {
  it.effect("serves the library, a policy and its versions", () =>
    Effect.gen(function* () {
      const api = yield* client(stub())
      assert.deepStrictEqual(yield* api.policies.list({ params: { repositoryId } }), [policy])
      assert.deepStrictEqual(yield* api.policies.get({ params }), detail)
      assert.deepStrictEqual(yield* api.policies.listVersions({ params }), [])
      assert.deepStrictEqual(
        yield* api.policies.validate({
          params: { repositoryId },
          payload: { source: detail.draft },
        }),
        { _tag: "Invalid", message: "Fact 'draft' is unknown" },
      )
    }),
  )

  it.effect("writes as the Access identity", () =>
    Effect.gen(function* () {
      const api = yield* client(stub())
      actors.length = 0
      const created = yield* api.policies.create({
        params: { repositoryId },
        payload: { name: "Ready", source: detail.draft },
      })
      assert.strictEqual(created.policy.name, "Ready")
      const updated = yield* api.policies.update({ params, payload: { version: 1 } })
      assert.strictEqual(updated.policy.version, 2)
      yield* api.policies.publish({ params, payload: { version: 2 } })
      yield* api.policies.delete({ params, query: { version: 3 } })
      const actor = { issuer: identity.issuer, subject: identity.subject }
      assert.deepStrictEqual(actors, [actor, actor, actor, actor])
    }),
  )

  it.effect("refuses with the policy's domain errors", () =>
    Effect.gen(function* () {
      const missingRepository = new RepositoryNotFound({ repositoryId })
      const disconnected = new RepositoryBlocked({ repositoryId, reason: "disconnected" })
      const missing = new PolicyNotFound({ policyId })
      const stale = new PolicyConflict({ current: detail })
      const taken = new PolicyNameTaken({ name: "Ready" })
      const invalid = new PolicyInvalid({ diagnostic: "Policy 'Ready' does not exist" })

      yield* refuses(
        [missingRepository],
        (refusal) => ({ list: () => Effect.fail(refusal) }),
        (api) => api.policies.list({ params: { repositoryId } }),
      )
      yield* refuses(
        [missingRepository, missing],
        (refusal) => ({ get: () => Effect.fail(refusal) }),
        (api) => api.policies.get({ params }),
      )
      yield* refuses(
        [missingRepository, missing],
        (refusal) => ({ versions: () => Effect.fail(refusal) }),
        (api) => api.policies.listVersions({ params }),
      )
      yield* refuses(
        [missingRepository],
        (refusal) => ({ validate: () => Effect.fail(refusal) }),
        (api) =>
          api.policies.validate({ params: { repositoryId }, payload: { source: detail.draft } }),
      )
      yield* refuses(
        [missingRepository, disconnected, taken, invalid],
        (refusal) => ({ create: () => Effect.fail(refusal) }),
        (api) =>
          api.policies.create({
            params: { repositoryId },
            payload: { name: "Ready", source: detail.draft },
          }),
      )
      yield* refuses(
        [missingRepository, disconnected, missing, stale, taken, invalid],
        (refusal) => ({ save: () => Effect.fail(refusal) }),
        (api) => api.policies.update({ params, payload: { version: 1, name: "Ready" } }),
      )
      yield* refuses(
        [missingRepository, disconnected, missing, stale, invalid],
        (refusal) => ({ publish: () => Effect.fail(refusal) }),
        (api) => api.policies.publish({ params, payload: { version: 1 } }),
      )
      yield* refuses(
        [
          missingRepository,
          disconnected,
          missing,
          stale,
          new PolicyInUse({ policyId, rules: 1, references: 2 }),
          new PolicyHistoryRetained({ policyId }),
        ],
        (refusal) => ({ remove: () => Effect.fail(refusal) }),
        (api) => api.policies.delete({ params, query: { version: 1 } }),
      )
    }),
  )
})
