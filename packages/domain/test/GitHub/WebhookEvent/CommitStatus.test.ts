import { describe, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Struct from "effect/Struct"
import { TestSchema } from "effect/testing"
import {
  GitHubCommitSha,
  GitHubCommitStatusDatabaseId,
  GitHubInstallationId,
  GitHubRepositoryDatabaseId,
  GitHubRepositoryNodeId,
  GitHubUserDatabaseId,
  GitHubWebhookDeliveryId,
} from "@janitor/domain/GitHub/Id"
import { GitHubWebhookEvent } from "@janitor/domain/GitHub/WebhookEvent"
import { CommitStatusWebhookPayload } from "@janitor/domain/GitHub/WebhookEvent/CommitStatus"

const createdAt = "2026-08-28T12:00:00.000Z"
const updatedAt = "2026-08-28T12:01:00.000Z"
const payload = {
  id: 123,
  sha: "a".repeat(40),
  name: "continuous-integration/janitor",
  target_url: "https://example.com/builds/123",
  context: "continuous-integration/janitor",
  description: "The build passed.",
  state: "success",
  created_at: createdAt,
  updated_at: updatedAt,
  repository: { id: 456, node_id: "R_kgDOJanitor", full_name: "effect/janitor" },
  installation: { id: 789 },
  sender: { id: 101, login: "janitor-app" },
} as const

const decodedPayload: CommitStatusWebhookPayload = {
  id: GitHubCommitStatusDatabaseId.make("123"),
  sha: GitHubCommitSha.make("a".repeat(40)),
  name: "continuous-integration/janitor",
  targetUrl: "https://example.com/builds/123",
  context: "continuous-integration/janitor",
  description: "The build passed.",
  state: "success",
  createdAt: DateTime.makeUnsafe(createdAt),
  updatedAt: DateTime.makeUnsafe(updatedAt),
  repository: {
    id: GitHubRepositoryDatabaseId.make("456"),
    nodeId: GitHubRepositoryNodeId.make("R_kgDOJanitor"),
    fullName: { owner: "effect", repo: "janitor" },
  },
  installation: { id: GitHubInstallationId.make("789") },
  sender: { id: GitHubUserDatabaseId.make("101"), login: "janitor-app" },
}

describe("commit status webhook payload schema", () => {
  it("decodes and normalizes a commit status", async () => {
    const decoding = new TestSchema.Asserts(CommitStatusWebhookPayload).decoding()

    await decoding.succeed(payload, decodedPayload)
  })

  it("encodes a commit status to GitHub wire keys", async () => {
    const encoding = new TestSchema.Asserts(CommitStatusWebhookPayload).encoding()

    await encoding.succeed(decodedPayload, payload)
  })

  it("rejects malformed commit data", async () => {
    const decoding = new TestSchema.Asserts(CommitStatusWebhookPayload).decoding()

    await decoding.fail(
      { ...payload, sha: "not-a-sha" },
      'Expected a string matching the RegExp ^[0-9a-f]{40}$\n  at ["sha"]',
    )
    await decoding.fail(
      { ...payload, state: "cancelled" },
      'Expected CommitStatusState\n  at ["state"]',
    )
  })

  it("distinguishes nullable fields from optional fields", async () => {
    const decoding = new TestSchema.Asserts(CommitStatusWebhookPayload).decoding()

    await decoding.succeed(
      { ...payload, target_url: null, description: null },
      { ...decodedPayload, targetUrl: null, description: null },
    )
    await decoding.fail(Struct.omit(payload, ["target_url"]), 'Missing key\n  at ["target_url"]')
  })
})

describe("commit status webhook event schema", () => {
  it("decodes through the aggregate event schema", async () => {
    const decoding = new TestSchema.Asserts(GitHubWebhookEvent).decoding()

    await decoding.succeed(
      {
        id: "delivery-789",
        name: "status",
        payload,
      },
      {
        id: GitHubWebhookDeliveryId.make("delivery-789"),
        name: "status",
        payload: decodedPayload,
      },
    )
  })

  it("accepts repository deliveries without an installation", async () => {
    const decoding = new TestSchema.Asserts(GitHubWebhookEvent).decoding()

    await decoding.succeed(
      {
        id: "delivery-790",
        name: "status",
        payload: Struct.omit(payload, ["installation"]),
      },
      {
        id: GitHubWebhookDeliveryId.make("delivery-790"),
        name: "status",
        payload: Struct.omit(decodedPayload, ["installation"]),
      },
    )
  })
})
