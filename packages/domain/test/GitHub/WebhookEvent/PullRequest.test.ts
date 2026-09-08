import { assert, describe, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import { TestSchema } from "effect/testing"
import {
  GitHubCommitSha,
  GitHubInstallationId,
  GitHubLabelDatabaseId,
  GitHubLabelNodeId,
  GitHubPullRequestDatabaseId,
  GitHubPullRequestNodeId,
  GitHubRepositoryDatabaseId,
  GitHubRepositoryNodeId,
  GitHubUserDatabaseId,
  GitHubWebhookDeliveryId,
} from "@janitor/domain/GitHub/Id"
import { GitHubWebhookEvent } from "@janitor/domain/GitHub/WebhookEvent"
import { PullRequestWebhookPayload } from "@janitor/domain/GitHub/WebhookEvent/PullRequest"

const updatedAt = "2026-09-02T12:00:00.000Z"

const payload = {
  number: 42,
  pull_request: {
    id: 123,
    number: 42,
    node_id: "PR_kwDOExample",
    title: "Fix repository cleanup",
    body: null,
    state: "open" as const,
    draft: false,
    merged: false,
    updated_at: updatedAt,
    labels: [{ id: 202, node_id: "LA_kwDOExample", name: "bug" }],
    user: { id: 102, login: "octocat" },
    head: { sha: "a".repeat(40) },
    base: { ref: "main" },
  },
  repository: {
    id: 456,
    node_id: "R_kgDOJanitor",
    full_name: "effect/janitor",
  },
  installation: { id: 789 },
  sender: { id: 101, login: "hubot" },
}

const openedPayload: PullRequestWebhookPayload = {
  number: 42,
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
    labels: [
      {
        id: GitHubLabelDatabaseId.make("202"),
        nodeId: GitHubLabelNodeId.make("LA_kwDOExample"),
        name: "bug",
      },
    ],
    user: { id: GitHubUserDatabaseId.make("102"), login: "octocat" },
    head: { sha: GitHubCommitSha.make("a".repeat(40)) },
    base: { ref: "main" },
  },
  repository: {
    id: GitHubRepositoryDatabaseId.make("456"),
    nodeId: GitHubRepositoryNodeId.make("R_kgDOJanitor"),
    fullName: { owner: "effect", repo: "janitor" },
  },
  installation: { id: GitHubInstallationId.make("789") },
  sender: { id: GitHubUserDatabaseId.make("101"), login: "hubot" },
  action: "opened",
}

describe("pull request webhook payload schema", () => {
  it("decodes and normalizes an opened payload", async () => {
    const decoding = new TestSchema.Asserts(PullRequestWebhookPayload).decoding()

    await decoding.succeed({ ...payload, action: "opened" }, openedPayload)
  })

  it("encodes an opened payload to GitHub wire keys", async () => {
    const encoding = new TestSchema.Asserts(PullRequestWebhookPayload).encoding()

    await encoding.succeed(openedPayload, {
      ...payload,
      repository: { id: 456, node_id: "R_kgDOJanitor", full_name: "effect/janitor" },
      installation: { id: 789 },
      action: "opened",
    })
  })

  it("decodes queued payloads without newly retained stable IDs", async () => {
    const decoding = new TestSchema.Asserts(PullRequestWebhookPayload).decoding()

    await decoding.succeed(
      {
        ...payload,
        action: "opened",
        pull_request: {
          ...payload.pull_request,
          user: { login: "octocat" },
        },
        repository: { id: 456, full_name: "effect/janitor" },
      },
      {
        ...openedPayload,
        pullRequest: {
          ...openedPayload.pullRequest,
          user: { login: "octocat" },
        },
        repository: {
          id: GitHubRepositoryDatabaseId.make("456"),
          fullName: { owner: "effect", repo: "janitor" },
        },
      },
    )
  })

  it("declares every supported action", () => {
    assert.deepStrictEqual(PullRequestWebhookPayload.discriminants, [
      "opened",
      "closed",
      "reopened",
      "synchronize",
      "edited",
      "ready_for_review",
      "converted_to_draft",
      "labeled",
      "unlabeled",
    ])
  })

  it("decodes synchronize and edited action data", async () => {
    const decoding = new TestSchema.Asserts(PullRequestWebhookPayload).decoding()
    const before = "b".repeat(40)
    const after = "c".repeat(40)
    const decodedBefore = GitHubCommitSha.make(before)
    const decodedAfter = GitHubCommitSha.make(after)

    await decoding.succeed(
      { ...payload, action: "synchronize", before, after },
      {
        ...openedPayload,
        action: "synchronize",
        before: decodedBefore,
        after: decodedAfter,
      },
    )
    await decoding.succeed(
      {
        ...payload,
        action: "edited",
        changes: { title: { from: "Old title" } },
      },
      {
        ...openedPayload,
        action: "edited",
        changes: { title: { from: "Old title" } },
      },
    )
  })

  it("requires label data for label actions", async () => {
    const decoding = new TestSchema.Asserts(PullRequestWebhookPayload).decoding()

    await decoding.fail({ ...payload, action: "labeled" }, 'Missing key\n  at ["label"]')
  })

  it("decodes labeled and unlabeled action data", async () => {
    const decoding = new TestSchema.Asserts(PullRequestWebhookPayload).decoding()
    const label = { id: 202, node_id: "LA_kwDOExample", name: "bug" }
    const decodedLabel = {
      id: GitHubLabelDatabaseId.make("202"),
      nodeId: GitHubLabelNodeId.make("LA_kwDOExample"),
      name: "bug",
    }

    await decoding.succeed(
      { ...payload, action: "labeled", label },
      { ...openedPayload, action: "labeled", label: decodedLabel },
    )
    await decoding.succeed(
      { ...payload, action: "unlabeled", label },
      { ...openedPayload, action: "unlabeled", label: decodedLabel },
    )
  })

  it("decodes a closed and merged payload", async () => {
    const decoding = new TestSchema.Asserts(PullRequestWebhookPayload).decoding()

    await decoding.succeed(
      {
        ...payload,
        action: "closed",
        pull_request: { ...payload.pull_request, state: "closed" as const, merged: true },
      },
      {
        ...openedPayload,
        action: "closed",
        pullRequest: { ...openedPayload.pullRequest, state: "closed", merged: true },
      },
    )
  })

  it("rejects unsupported actions with a useful message", async () => {
    const decoding = new TestSchema.Asserts(PullRequestWebhookPayload).decoding()

    await decoding.fail(
      { ...payload, action: "assigned" },
      "Unsupported or malformed pull request webhook action",
    )
  })
})

describe("pull request webhook event schema", () => {
  it("decodes the delivery envelope", async () => {
    const decoding = new TestSchema.Asserts(GitHubWebhookEvent).decoding()

    await decoding.succeed(
      {
        id: "delivery-123",
        name: "pull_request",
        payload: { ...payload, action: "opened" },
      },
      {
        id: GitHubWebhookDeliveryId.make("delivery-123"),
        name: "pull_request",
        payload: openedPayload,
      },
    )
  })
})
