import { describe, it } from "@effect/vitest"
import { TestSchema } from "effect/testing"
import {
  GitHubCommitSha,
  GitHubInstallationId,
  GitHubRepositoryDatabaseId,
  GitHubRepositoryNodeId,
  GitHubWebhookDeliveryId,
} from "@janitor/domain/GitHub/Id"
import { GitHubWebhookEvent } from "@janitor/domain/GitHub/WebhookEvent"

const sha = "a".repeat(40)
const repository = {
  id: 456,
  node_id: "R_kgDOJanitor",
  full_name: "effect/janitor",
}
const decodedRepository = {
  id: GitHubRepositoryDatabaseId.make("456"),
  nodeId: GitHubRepositoryNodeId.make("R_kgDOJanitor"),
  fullName: { owner: "effect", repo: "janitor" },
}

describe("check webhook event schemas", () => {
  it("normalizes check run commit SHAs", async () => {
    const decoding = new TestSchema.Asserts(GitHubWebhookEvent).decoding()

    await decoding.succeed(
      {
        id: "delivery-run",
        name: "check_run",
        payload: {
          action: "completed",
          check_run: { head_sha: sha },
          repository,
          installation: { id: 789 },
        },
      },
      {
        id: GitHubWebhookDeliveryId.make("delivery-run"),
        name: "check_run",
        payload: {
          action: "completed",
          check_run: { head_sha: GitHubCommitSha.make(sha) },
          repository: decodedRepository,
          installation: { id: GitHubInstallationId.make("789") },
        },
      },
    )
  })

  it("rejects malformed check suite commit SHAs", async () => {
    const decoding = new TestSchema.Asserts(GitHubWebhookEvent).decoding()

    await decoding.fail(
      {
        id: "delivery-suite",
        name: "check_suite",
        payload: {
          action: "requested",
          check_suite: { head_sha: "not-a-sha" },
          repository,
          installation: { id: 789 },
        },
      },
      'Expected a string matching the RegExp ^[0-9a-f]{40}$\n  at ["payload"]["check_suite"]["head_sha"]',
    )
  })
})
