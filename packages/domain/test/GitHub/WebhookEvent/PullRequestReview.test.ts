import { assert, describe, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import { TestSchema } from "effect/testing"
import {
  GitHubCommitSha,
  GitHubInstallationId,
  GitHubPullRequestDatabaseId,
  GitHubPullRequestNodeId,
  GitHubPullRequestReviewDatabaseId,
  GitHubPullRequestReviewNodeId,
  GitHubRepositoryDatabaseId,
  GitHubRepositoryNodeId,
  GitHubUserDatabaseId,
  GitHubWebhookDeliveryId,
} from "@janitor/domain/GitHub/Id"
import { GitHubWebhookEvent } from "@janitor/domain/GitHub/WebhookEvent"
import { PullRequestReviewWebhookPayload } from "@janitor/domain/GitHub/WebhookEvent/PullRequestReview"

const submittedAt = "2026-08-28T12:00:00.000Z"
const updatedAt = "2026-08-28T11:00:00.000Z"
const payload = {
  pull_request: {
    id: 123,
    number: 42,
    node_id: "PR_kwDOExample",
    title: "Fix repository cleanup",
    body: null,
    state: "open",
    draft: false,
    merged: false,
    updated_at: updatedAt,
    labels: [],
    user: { id: 102, login: "octocat" },
    head: { sha: "a".repeat(40) },
    base: { ref: "main" },
  },
  review: {
    id: 202,
    node_id: "PRR_kwDOExample",
    user: { id: 303, login: "reviewer" },
    body: "Looks good.",
    commit_id: "a".repeat(40),
    submitted_at: submittedAt,
    state: "approved",
  },
  repository: { id: 456, node_id: "R_kgDOJanitor", full_name: "effect/janitor" },
  installation: { id: 789 },
  sender: { id: 303, login: "reviewer" },
} as const

const submittedPayload: PullRequestReviewWebhookPayload = {
  action: "submitted",
  pullRequest: {
    id: GitHubPullRequestDatabaseId.make("123"),
    number: 42,
    nodeId: GitHubPullRequestNodeId.make("PR_kwDOExample"),
    title: "Fix repository cleanup",
    body: null,
    state: "open",
    draft: false,
    merged: false,
    updatedAt: DateTime.makeUnsafe(updatedAt),
    labels: [],
    user: { id: GitHubUserDatabaseId.make("102"), login: "octocat" },
    head: { sha: GitHubCommitSha.make("a".repeat(40)) },
    base: { ref: "main" },
  },
  review: {
    id: GitHubPullRequestReviewDatabaseId.make("202"),
    nodeId: GitHubPullRequestReviewNodeId.make("PRR_kwDOExample"),
    user: { id: GitHubUserDatabaseId.make("303"), login: "reviewer" },
    body: "Looks good.",
    commitId: GitHubCommitSha.make("a".repeat(40)),
    submittedAt: DateTime.makeUnsafe(submittedAt),
    state: "approved",
  },
  repository: {
    id: GitHubRepositoryDatabaseId.make("456"),
    nodeId: GitHubRepositoryNodeId.make("R_kgDOJanitor"),
    fullName: { owner: "effect", repo: "janitor" },
  },
  installation: { id: GitHubInstallationId.make("789") },
  sender: { id: GitHubUserDatabaseId.make("303"), login: "reviewer" },
}

describe("pull request review webhook payload schema", () => {
  it("decodes and normalizes a submitted review", async () => {
    const decoding = new TestSchema.Asserts(PullRequestReviewWebhookPayload).decoding()

    await decoding.succeed({ ...payload, action: "submitted" }, submittedPayload)
  })

  it("encodes a submitted review to GitHub wire keys", async () => {
    const encoding = new TestSchema.Asserts(PullRequestReviewWebhookPayload).encoding()

    await encoding.succeed(submittedPayload, { ...payload, action: "submitted" })
  })

  it("declares every supported action", () => {
    assert.deepStrictEqual(PullRequestReviewWebhookPayload.discriminants, [
      "submitted",
      "edited",
      "dismissed",
    ])
  })

  it("requires changes for edited reviews", async () => {
    const decoding = new TestSchema.Asserts(PullRequestReviewWebhookPayload).decoding()

    await decoding.fail({ ...payload, action: "edited" }, 'Missing key\n  at ["changes"]')
  })

  it("requires dismissed state for dismissed reviews", async () => {
    const decoding = new TestSchema.Asserts(PullRequestReviewWebhookPayload).decoding()

    await decoding.fail(
      { ...payload, action: "dismissed" },
      'Expected "dismissed"\n  at ["review"]["state"]',
    )
  })

  it("rejects dismissed state for submitted reviews", async () => {
    const decoding = new TestSchema.Asserts(PullRequestReviewWebhookPayload).decoding()

    await decoding.fail(
      {
        ...payload,
        action: "submitted",
        review: { ...payload.review, state: "dismissed" },
      },
      'Expected "commented" | "changes_requested" | "approved"\n  at ["review"]["state"]',
    )
  })

  it("decodes edited and dismissed reviews", async () => {
    const decoding = new TestSchema.Asserts(PullRequestReviewWebhookPayload).decoding()

    await decoding.succeed(
      {
        ...payload,
        action: "edited",
        changes: { body: { from: "Previous review." } },
      },
      {
        ...submittedPayload,
        action: "edited",
        changes: { body: { from: "Previous review." } },
      },
    )
    await decoding.succeed(
      {
        ...payload,
        action: "dismissed",
        review: { ...payload.review, state: "dismissed" },
      },
      {
        ...submittedPayload,
        action: "dismissed",
        review: { ...submittedPayload.review, state: "dismissed" },
      },
    )
  })

  it("rejects unsupported actions with a useful message", async () => {
    const decoding = new TestSchema.Asserts(PullRequestReviewWebhookPayload).decoding()

    await decoding.fail(
      { ...payload, action: "created" },
      "Unsupported or malformed pull request review webhook action",
    )
  })
})

describe("pull request review webhook event schema", () => {
  it("decodes through the aggregate event schema", async () => {
    const decoding = new TestSchema.Asserts(GitHubWebhookEvent).decoding()

    await decoding.succeed(
      {
        id: "delivery-456",
        name: "pull_request_review",
        payload: { ...payload, action: "submitted" },
      },
      {
        id: GitHubWebhookDeliveryId.make("delivery-456"),
        name: "pull_request_review",
        payload: submittedPayload,
      },
    )
  })
})
