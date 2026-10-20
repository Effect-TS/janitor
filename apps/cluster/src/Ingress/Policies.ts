import { JanitorApi } from "@janitor/domain/Api"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import { Policies } from "../Labeling/Policies.ts"
import { CurrentAccessIdentity } from "./Middleware.ts"

const actor = Effect.map(CurrentAccessIdentity, (identity) => ({
  issuer: identity.issuer,
  subject: identity.subject,
}))

/**
 * A repository's policy library. The service fails with the domain errors
 * each endpoint declares; its infrastructure failures die.
 */
export const PoliciesGroupLayer = HttpApiBuilder.group(JanitorApi, "policies", (handlers) =>
  handlers
    .handle("list", ({ params }) => Policies.use((policies) => policies.list(params.repositoryId)))
    .handle("get", ({ params }) =>
      Policies.use((policies) => policies.get(params.repositoryId, params.policyId)),
    )
    .handle("listVersions", ({ params }) =>
      Policies.use((policies) => policies.versions(params.repositoryId, params.policyId)),
    )
    .handle("create", ({ params, payload }) =>
      Effect.gen(function* () {
        const policies = yield* Policies
        return yield* policies.create(params.repositoryId, payload, yield* actor)
      }),
    )
    .handle("update", ({ params, payload }) =>
      Effect.gen(function* () {
        const policies = yield* Policies
        return yield* policies.save(params.repositoryId, params.policyId, payload, yield* actor)
      }),
    )
    .handle("publish", ({ params, payload }) =>
      Effect.gen(function* () {
        const policies = yield* Policies
        return yield* policies.publish(
          params.repositoryId,
          params.policyId,
          payload.version,
          yield* actor,
        )
      }),
    )
    .handle("delete", ({ params, query }) =>
      Effect.gen(function* () {
        const policies = yield* Policies
        yield* policies.remove(params.repositoryId, params.policyId, query.version, yield* actor)
      }),
    )
    .handle("validate", ({ params, payload }) =>
      Policies.use((policies) =>
        policies.validate(params.repositoryId, payload.source, Option.none()),
      ),
    ),
)
