import type { GitHubWebhookDeliveryId } from "@janitor/domain/GitHub/Id"
import type { OutboxRequest } from "../WorkflowOutbox.ts"

/** Shared by the journal (producer) and the workflow (consumer) to avoid a module cycle. */
export const PROJECT_GITHUB_WEBHOOK_TAG = "Janitor/ProjectGitHubWebhookV1"

export const projectGitHubWebhookRequest = (
  deliveryId: GitHubWebhookDeliveryId,
): OutboxRequest => ({
  workflowTag: PROJECT_GITHUB_WEBHOOK_TAG,
  executionKey: deliveryId,
  payload: { deliveryId },
})
