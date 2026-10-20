import * as Schema from "effect/Schema"
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint"
import * as HttpApiGroup from "effect/http-api/HttpApiGroup"
import { GitHubRepositoryDatabaseId } from "../GitHub/Id.ts"
import { RepositoryNotFound } from "../GitHub/Repository.ts"
import { ActivityCursor, ActivityPage } from "../Labeling/Activity.ts"
import {
  AiConsent,
  AuditEntry,
  ConfigurationView,
  SetAiConsentRequest,
} from "../Labeling/Policy/Configuration.ts"
import { FactDescription } from "../Labeling/Policy/Facts.ts"
import { ReconciliationRecord, RepositoryOverview } from "../Labeling/Reconciliation.ts"

const repository = { repositoryId: GitHubRepositoryDatabaseId }

/**
 * Automatic labeling across repositories: the overview, the fact catalog, a
 * repository's configuration, reconciliation activity and audit trail, and
 * its consent to AI classification.
 */
export class LabelingGroup extends HttpApiGroup.make("labeling")
  .add(
    HttpApiEndpoint.get("listRepositories", "/repositories", {
      success: Schema.Array(RepositoryOverview),
    }),
  )
  .add(
    HttpApiEndpoint.get("getCatalog", "/labeling/catalog", {
      success: Schema.Array(FactDescription),
    }),
  )
  .add(
    HttpApiEndpoint.get("getConfiguration", "/repositories/:repositoryId/configuration", {
      params: repository,
      success: ConfigurationView,
      error: RepositoryNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("listActivity", "/repositories/:repositoryId/activity", {
      params: repository,
      query: {
        search: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
        target: Schema.optionalKey(Schema.Literals(["all", "issue", "pull_request"])),
        cursor: Schema.optionalKey(Schema.fromJsonString(ActivityCursor)),
      },
      success: ActivityPage,
      error: RepositoryNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("listReconciliations", "/repositories/:repositoryId/reconciliations", {
      params: repository,
      success: Schema.Array(ReconciliationRecord),
    }),
  )
  .add(
    HttpApiEndpoint.get("listAudit", "/repositories/:repositoryId/audit", {
      params: repository,
      success: Schema.Array(AuditEntry),
      error: RepositoryNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("getAiConsent", "/repositories/:repositoryId/ai-consent", {
      params: repository,
      success: AiConsent,
      error: RepositoryNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.put("updateAiConsent", "/repositories/:repositoryId/ai-consent", {
      params: repository,
      payload: SetAiConsentRequest,
      success: AiConsent,
      error: RepositoryNotFound,
    }),
  ) {}
