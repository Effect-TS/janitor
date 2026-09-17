import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { AutomationIntegration } from "../AutomationIntegration.ts"
import { IssueLabelingAdmission } from "./IssueLabeling.ts"

/** Issue events admit direct labeling; the projection stays unaware of labeling. */
export const LabelingAutomationIntegrationLayer = Layer.effect(
  AutomationIntegration,
  Effect.gen(function* () {
    const admission = yield* IssueLabelingAdmission
    return {
      issueEvent: (request) =>
        admission.admit(request).pipe(
          Effect.tap((result) =>
            result._tag === "Skipped"
              ? Effect.logDebug("Issue event not admitted for labeling").pipe(
                  Effect.annotateLogs({
                    repositoryId: request.repositoryId,
                    number: request.issue.number,
                    reason: result.reason,
                  }),
                )
              : Effect.void,
          ),
          Effect.asVoid,
        ),
    }
  }),
).pipe(Layer.provide(IssueLabelingAdmission.layer))
