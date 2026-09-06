import { RuleTestJobs } from "../../src/Labeling/RuleTestJob.ts"
import { assert, describe, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import { GitHubLabelDatabaseId, GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { PolicyId } from "@janitor/domain/Labeling/Policy/Condition"
import {
  type ConfigurationView,
  LabelingRevision,
  type PolicyDetail,
  type PolicyRecord,
  type RuleRecord,
} from "@janitor/domain/Labeling/Policy/Configuration"
import { RuleId } from "@janitor/domain/Labeling/Policy/Plan"
import { CurrentAccessIdentity } from "../../src/Ingress/Middleware.ts"
import { RulesRoutesLayer } from "../../src/Ingress/Rules.ts"
import { AiConsentService } from "../../src/Labeling/Classifier.ts"
import { LabelingConfiguration } from "../../src/Labeling/Configuration.ts"
import { LabelingOverview } from "../../src/Labeling/Overview.ts"
import {
  Policies,
  PolicyConflict,
  PolicyInvalid,
  PolicyNotFound,
} from "../../src/Labeling/Policies.ts"
import { LabelingRules, RuleInvalid } from "../../src/Labeling/Rules.ts"
import { LabelingTest } from "../../src/Labeling/Test.ts"

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
const rule: RuleRecord = {
  id: RuleId.make("rule-1"),
  repositoryId,
  labelId: GitHubLabelDatabaseId.make("11"),
  policyId,
  onNoMatch: "ensure-absent",
  group: null,
  priority: 0,
  enabled: true,
  labelStatus: "valid",
  version: 1,
  createdAt: at,
  updatedAt: at,
}
const view: ConfigurationView = {
  repositoryId,
  configuredRevision: LabelingRevision.make(1),
  activeRevision: null,
  pendingTracks: ["entities"],
  policies: [policy],
  rules: [rule],
  labels: [{ labelId: rule.labelId, name: "bug", availability: "available" }],
  labelFreshness: "verified",
}

const unused = () => Effect.die("unused")

const policies: Policies["Service"] = {
  list: () => Effect.succeed([policy]),
  get: (_, id) =>
    id === policyId ? Effect.succeed(detail) : Effect.fail(new PolicyNotFound({ policyId: id })),
  create: (_, request, actor) =>
    Effect.succeed({
      ...detail,
      policy: { ...policy, name: request.name, description: actor.subject },
    }),
  save: (_, __, request) =>
    request.version === 1
      ? Effect.succeed({ ...detail, policy: { ...policy, version: 2 } })
      : Effect.fail(new PolicyConflict({ current: detail })),
  publish: () =>
    Effect.fail(new PolicyInvalid({ message: "Fact 'draft' does not exist for issue" })),
  validate: () =>
    Effect.succeed({
      _tag: "Valid",
      manifest: {
        facts: ["baseRef"],
        tracks: ["pull_requests"],
        references: [],
        nodeCount: 1,
        expandedNodeCount: 1,
      },
    }),
  versions: () => Effect.succeed([]),
  remove: unused,
  names: unused,
  resolver: unused,
}

const rules: LabelingRules["Service"] = {
  list: () => Effect.succeed([rule]),
  create: (_, request) =>
    request.labelId === rule.labelId
      ? Effect.succeed(rule)
      : Effect.fail(new RuleInvalid({ issues: [{ code: "unresolved-label", message: "nope" }] })),
  patch: () => Effect.succeed({ ...rule, version: 2 }),
  remove: () => Effect.void,
  audit: () => Effect.succeed([]),
}

const configuration: LabelingConfiguration["Service"] = {
  requireRepository: () => Effect.void,
  labels: unused,
  load: unused,
  advance: unused,
  view: () => Effect.succeed(view),
}

const test: LabelingTest["Service"] = {
  items: () => Effect.succeed([]),
  run: () => Effect.succeed({ _tag: "Evaluated", entities: [] }),
}

const consentService: AiConsentService["Service"] = {
  get: () =>
    Effect.succeed({
      repositoryId,
      state: "disabled",
      provider: "openai",
      model: "gpt-5.6-luna",
      activeLeases: 0,
      updatedAt: at,
    }),
  set: (_, enabled) =>
    Effect.succeed({
      repositoryId,
      state: enabled ? "enabled" : "disabled",
      provider: "openai",
      model: "gpt-5.6-luna",
      activeLeases: 0,
      updatedAt: at,
    }),
  settleDraining: Effect.succeed(0),
}

const overview: LabelingOverview["Service"] = {
  repositories: Effect.succeed([]),
  reconciliations: () => Effect.succeed([]),
}

const withHandler = <A, E, R>(
  use: (handler: (request: Request) => Promise<Response>) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => HttpRouter.toWebHandler(RulesRoutesLayer, { disableLogger: true })),
    ({ handler }) =>
      use((request) =>
        handler(
          request,
          Context.make(Policies, policies).pipe(
            Context.add(LabelingRules, rules),
            Context.add(LabelingConfiguration, configuration),
            Context.add(LabelingTest, test),
            Context.add(RuleTestJobs, {
              enqueue: () =>
                Effect.succeed({
                  testId: "test-1",
                  status: "queued",
                  response: null,
                  message: null,
                }),
              get: () => Effect.succeed(null),
            }),
            Context.add(LabelingOverview, overview),
            Context.add(AiConsentService, consentService),
            Context.add(CurrentAccessIdentity, identity),
          ),
        ),
      ),
    ({ dispose }) => Effect.promise(dispose),
  )

const request = (method: string, path: string, body?: unknown, site = "same-origin") =>
  new Request(`https://janitor.example${path}`, {
    method,
    headers: { "sec-fetch-site": site, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const base = `/repositories/${repositoryId}`

describe("RulesRoutes", () => {
  it.effect("serves the configuration, policies, and rules", () =>
    withHandler((handler) =>
      Effect.gen(function* () {
        const configured = yield* Effect.promise(() =>
          handler(request("GET", `${base}/configuration`)),
        )
        assert.strictEqual(configured.status, 200)
        const body = yield* Effect.promise(() => configured.json())
        assert.deepStrictEqual(body.pendingTracks, ["entities"])
        assert.strictEqual(body.rules[0].labelId, "11")

        const one = yield* Effect.promise(() =>
          handler(request("GET", `${base}/policies/${policyId}`)),
        )
        assert.strictEqual(one.status, 200)
        const missing = yield* Effect.promise(() =>
          handler(request("GET", `${base}/policies/nope`)),
        )
        assert.strictEqual(missing.status, 404)
        const malformed = yield* Effect.promise(() =>
          handler(request("GET", "/repositories/x/rules")),
        )
        assert.strictEqual(malformed.status, 400)
      }),
    ),
  )

  it.effect("writes with the Access identity and maps failures to statuses", () =>
    withHandler((handler) =>
      Effect.gen(function* () {
        const created = yield* Effect.promise(() =>
          handler(request("POST", `${base}/policies`, { name: "Ready", source: detail.draft })),
        )
        assert.strictEqual(created.status, 201)
        assert.strictEqual(
          (yield* Effect.promise(() => created.json())).policy.description,
          "user-1",
        )

        const conflict = yield* Effect.promise(() =>
          handler(request("PUT", `${base}/policies/${policyId}`, { version: 9 })),
        )
        assert.strictEqual(conflict.status, 409)
        const invalid = yield* Effect.promise(() =>
          handler(request("POST", `${base}/policies/${policyId}/publish`, { version: 1 })),
        )
        assert.strictEqual(invalid.status, 422)
        assert.include((yield* Effect.promise(() => invalid.json())).message, "issue")
        const validated = yield* Effect.promise(() =>
          handler(request("POST", `${base}/policies/validate`, { source: detail.draft })),
        )
        assert.strictEqual((yield* Effect.promise(() => validated.json()))._tag, "Valid")

        const ruleInvalid = yield* Effect.promise(() =>
          handler(
            request("POST", `${base}/rules`, { labelId: "404", policyId, onNoMatch: "preserve" }),
          ),
        )
        assert.strictEqual(ruleInvalid.status, 422)
        const ruleCreated = yield* Effect.promise(() =>
          handler(
            request("POST", `${base}/rules`, { labelId: "11", policyId, onNoMatch: "preserve" }),
          ),
        )
        assert.strictEqual(ruleCreated.status, 201)
        const removed = yield* Effect.promise(() =>
          handler(request("DELETE", `${base}/rules/rule-1?version=1`)),
        )
        assert.strictEqual(removed.status, 204)
        const tested = yield* Effect.promise(() =>
          handler(request("POST", `${base}/test`, { subject: { _tag: "Configuration" } })),
        )
        assert.strictEqual(tested.status, 200)
        const consented = yield* Effect.promise(() =>
          handler(request("PUT", `${base}/ai-consent`, { enabled: true })),
        )
        assert.strictEqual((yield* Effect.promise(() => consented.json())).state, "enabled")

        const crossOrigin = yield* Effect.promise(() =>
          handler(
            request(
              "POST",
              `${base}/rules`,
              { labelId: "11", policyId, onNoMatch: "preserve" },
              "cross-site",
            ),
          ),
        )
        assert.strictEqual(crossOrigin.status, 403)
      }),
    ),
  )
})
