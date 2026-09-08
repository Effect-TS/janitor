import { assert, describe, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import { TestSchema } from "effect/testing"
import {
  GitHubAccountDatabaseId,
  GitHubInstallationId,
  GitHubRepositoryDatabaseId,
  GitHubRepositoryNodeId,
  GitHubUserDatabaseId,
  GitHubWebhookDeliveryId,
} from "@janitor/domain/GitHub/Id"
import {
  GitHubInstallationRepository,
  GitHubInstallationSummary,
} from "@janitor/domain/GitHub/Installation"
import { GitHubWebhookEvent } from "@janitor/domain/GitHub/WebhookEvent"
import {
  InstallationRepositoriesWebhookPayload,
  InstallationWebhookPayload,
} from "@janitor/domain/GitHub/WebhookEvent/Installation"

const installation: typeof GitHubInstallationSummary.Encoded = {
  id: 123,
  account: { id: 456, login: "effect", type: "Organization" },
  repository_selection: "selected",
  html_url: "https://github.com/settings/installations/123",
  suspended_at: null,
}

const normalizedInstallation: GitHubInstallationSummary = {
  id: GitHubInstallationId.make("123"),
  account: {
    id: GitHubAccountDatabaseId.make("456"),
    login: "effect",
    type: "Organization",
  },
  repositorySelection: "selected",
  htmlUrl: "https://github.com/settings/installations/123",
  suspendedAt: null,
}

const repository: typeof GitHubInstallationRepository.Encoded = {
  id: 789,
  node_id: "R_kgDOJanitor",
  full_name: "effect/janitor",
  private: false,
}

const normalizedRepository: GitHubInstallationRepository = {
  id: GitHubRepositoryDatabaseId.make("789"),
  nodeId: GitHubRepositoryNodeId.make("R_kgDOJanitor"),
  fullName: { owner: "effect", repo: "janitor" },
  isPrivate: false,
}

const sender = { id: 101, login: "octocat" }
const normalizedSender = { id: GitHubUserDatabaseId.make("101"), login: "octocat" }

describe("installation webhook payload schema", () => {
  it("decodes and normalizes a created payload", async () => {
    const decoding = new TestSchema.Asserts(InstallationWebhookPayload).decoding()

    await decoding.succeed(
      {
        action: "created",
        installation,
        repositories: [repository],
        requester: null,
        sender,
      },
      {
        action: "created",
        installation: normalizedInstallation,
        repositories: [normalizedRepository],
        requester: null,
        sender: normalizedSender,
      },
    )
  })

  it("declares every supported installation action", () => {
    assert.deepStrictEqual(InstallationWebhookPayload.discriminants, [
      "created",
      "deleted",
      "suspend",
      "unsuspend",
      "new_permissions_accepted",
    ])
  })

  it("retains repositories on non-created actions", async () => {
    const decoding = new TestSchema.Asserts(InstallationWebhookPayload).decoding()

    await decoding.succeed(
      { action: "deleted", installation, repositories: [repository], requester: null, sender },
      {
        action: "deleted",
        installation: normalizedInstallation,
        repositories: [normalizedRepository],
        requester: null,
        sender: normalizedSender,
      },
    )
  })

  it("validates suspend and unsuspend state", async () => {
    const decoding = new TestSchema.Asserts(InstallationWebhookPayload).decoding()
    const suspendedAt = "2026-08-28T12:00:00.000Z"

    await decoding.succeed(
      {
        action: "suspend",
        installation: { ...installation, suspended_at: suspendedAt, suspended_by: sender },
        requester: null,
        sender,
      },
      {
        action: "suspend",
        installation: {
          ...normalizedInstallation,
          suspendedAt: DateTime.makeUnsafe(suspendedAt),
          suspendedBy: normalizedSender,
        },
        requester: null,
        sender: normalizedSender,
      },
    )

    await decoding.fail(
      {
        action: "suspend",
        installation: { ...installation, suspended_at: "invalid", suspended_by: sender },
        requester: null,
        sender,
      },
      'Expected a valid UTC DateTime string\n  at ["installation"]["suspendedAt"]',
    )
    await decoding.fail(
      {
        action: "unsuspend",
        installation,
        requester: null,
        sender,
      },
      'Expected an unsuspended GitHub installation\n  at ["installation"]',
    )
    await decoding.succeed(
      {
        action: "unsuspend",
        installation: { ...installation, suspended_by: null },
        requester: null,
        sender,
      },
      {
        action: "unsuspend",
        installation: { ...normalizedInstallation, suspendedBy: null },
        requester: null,
        sender: normalizedSender,
      },
    )
  })

  it("rejects non-null requesters on non-created actions", async () => {
    const decoding = new TestSchema.Asserts(InstallationWebhookPayload).decoding()

    await decoding.fail(
      { action: "deleted", installation, requester: sender, sender },
      'Expected null\n  at ["requester"]',
    )
  })

  it("rejects unsupported installation actions", async () => {
    const decoding = new TestSchema.Asserts(InstallationWebhookPayload).decoding()

    await decoding.fail(
      { action: "updated", installation, sender },
      "Unsupported or malformed installation webhook action",
    )
  })
})

describe("installation repositories webhook payload schema", () => {
  it("declares both repository change actions", () => {
    assert.deepStrictEqual(InstallationRepositoriesWebhookPayload.discriminants, [
      "added",
      "removed",
    ])
  })

  it("round-trips and normalizes repository changes", async () => {
    const asserts = new TestSchema.Asserts(InstallationRepositoriesWebhookPayload)
    const payload: InstallationRepositoriesWebhookPayload = {
      action: "added",
      installation: normalizedInstallation,
      repositorySelection: "selected",
      repositoriesAdded: [normalizedRepository],
      repositoriesRemoved: [],
      requester: null,
      sender: normalizedSender,
    }

    await asserts.decoding().succeed(
      {
        action: "added",
        installation,
        repository_selection: "selected",
        repositories_added: [repository],
        repositories_removed: [],
        requester: null,
        sender,
      },
      payload,
    )
    await asserts.encoding().succeed(payload, {
      action: "added",
      installation,
      repository_selection: "selected",
      repositories_added: [repository],
      repositories_removed: [],
      requester: null,
      sender,
    })
  })

  it("decodes removed repositories", async () => {
    const decoding = new TestSchema.Asserts(InstallationRepositoriesWebhookPayload).decoding()

    await decoding.succeed(
      {
        action: "removed",
        installation,
        repository_selection: "selected",
        repositories_added: [],
        repositories_removed: [repository],
        requester: null,
        sender,
      },
      {
        action: "removed",
        installation: normalizedInstallation,
        repositorySelection: "selected",
        repositoriesAdded: [],
        repositoriesRemoved: [normalizedRepository],
        requester: null,
        sender: normalizedSender,
      },
    )
  })

  it("rejects contradictory repository changes", async () => {
    const decoding = new TestSchema.Asserts(InstallationRepositoriesWebhookPayload).decoding()

    await decoding.fail(
      {
        action: "added",
        installation,
        repository_selection: "selected",
        repositories_added: [repository],
        repositories_removed: [repository],
        requester: null,
        sender,
      },
      'Expected no excess property\n  at ["repositories_removed"][0]',
    )
    await decoding.fail(
      {
        action: "removed",
        installation,
        repository_selection: "selected",
        repositories_added: [repository],
        repositories_removed: [repository],
        requester: null,
        sender,
      },
      'Expected no excess property\n  at ["repositories_added"][0]',
    )
  })
})

describe("installation webhook event schema", () => {
  it("decodes through the aggregate event schema", async () => {
    const decoding = new TestSchema.Asserts(GitHubWebhookEvent).decoding()

    await decoding.succeed(
      {
        id: "delivery-123",
        name: "installation",
        payload: { action: "deleted", installation, sender },
      },
      {
        id: GitHubWebhookDeliveryId.make("delivery-123"),
        name: "installation",
        payload: {
          action: "deleted",
          installation: normalizedInstallation,
          sender: normalizedSender,
        },
      },
    )
  })

  it("decodes repository changes through the aggregate event schema", async () => {
    const decoding = new TestSchema.Asserts(GitHubWebhookEvent).decoding()

    await decoding.succeed(
      {
        id: "delivery-456",
        name: "installation_repositories",
        payload: {
          action: "added",
          installation,
          repository_selection: "selected",
          repositories_added: [repository],
          repositories_removed: [],
          requester: null,
          sender,
        },
      },
      {
        id: GitHubWebhookDeliveryId.make("delivery-456"),
        name: "installation_repositories",
        payload: {
          action: "added",
          installation: normalizedInstallation,
          repositorySelection: "selected",
          repositoriesAdded: [normalizedRepository],
          repositoriesRemoved: [],
          requester: null,
          sender: normalizedSender,
        },
      },
    )
  })
})
