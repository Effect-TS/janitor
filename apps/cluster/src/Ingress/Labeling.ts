import { JanitorApi } from "@janitor/domain/Api"
import { describeCatalog } from "@janitor/domain/Labeling/Policy/Facts"
import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import { ActivityReader } from "../Labeling/Activity.ts"
import { AiConsentService } from "../Labeling/Classifier.ts"
import { LabelingConfiguration } from "../Labeling/Configuration.ts"
import { LabelingOverview } from "../Labeling/Overview.ts"
import { LabelingRules } from "../Labeling/Rules.ts"
import { CurrentAccessIdentity } from "./Middleware.ts"

const catalog = describeCatalog()

/**
 * Labeling across repositories. The services fail with `RepositoryNotFound`
 * where an endpoint declares it; their infrastructure failures die.
 */
export const LabelingGroupLayer = HttpApiBuilder.group(JanitorApi, "labeling", (handlers) =>
  handlers
    .handle("listRepositories", () =>
      LabelingOverview.use((overview) => overview.repositories).pipe(
        Effect.catchTag("LabelingOverviewError", Effect.die),
      ),
    )
    .handle("getCatalog", () => Effect.succeed(catalog))
    .handle("getConfiguration", ({ params }) =>
      LabelingConfiguration.use((configuration) => configuration.view(params.repositoryId)).pipe(
        Effect.catchTag("LabelingConfigurationError", Effect.die),
      ),
    )
    .handle("listActivity", ({ params, query }) =>
      ActivityReader.use((reader) =>
        reader.page(params.repositoryId, {
          search: query.search ?? "",
          target: query.target ?? "all",
          cursor: query.cursor ?? null,
        }),
      ).pipe(
        Effect.catchTags({
          LabelingConfigurationError: Effect.die,
          SchemaError: Effect.die,
          SqlError: Effect.die,
        }),
      ),
    )
    .handle("listReconciliations", ({ params }) =>
      LabelingOverview.use((overview) => overview.reconciliations(params.repositoryId)).pipe(
        Effect.catchTag("LabelingOverviewError", Effect.die),
      ),
    )
    .handle("listAudit", ({ params }) =>
      LabelingRules.use((rules) => rules.audit(params.repositoryId)),
    )
    .handle("getAiConsent", ({ params }) =>
      Effect.gen(function* () {
        yield* (yield* LabelingConfiguration).requireRepository(params.repositoryId)
        return yield* (yield* AiConsentService).get(params.repositoryId)
      }).pipe(
        Effect.catchTags({ LabelingConfigurationError: Effect.die, AiConsentError: Effect.die }),
      ),
    )
    .handle("updateAiConsent", ({ params, payload }) =>
      Effect.gen(function* () {
        yield* (yield* LabelingConfiguration).requireRepository(params.repositoryId)
        const identity = yield* CurrentAccessIdentity
        return yield* (yield* AiConsentService).set(params.repositoryId, payload.enabled, {
          issuer: identity.issuer,
          subject: identity.subject,
        })
      }).pipe(
        Effect.catchTags({ LabelingConfigurationError: Effect.die, AiConsentError: Effect.die }),
      ),
    ),
)
