import { describe, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import { TestSchema } from "effect/testing"
import {
  GitHubAccountDatabaseId,
  GitHubAccountDatabaseIdFromNumber,
  GitHubAccountDatabaseIdFromStringOrNumber,
  GitHubInstallationId,
  GitHubRepositoryDatabaseId,
  GitHubRepositoryNodeId,
} from "@janitor/domain/GitHub/Id"
import {
  GitHubInstallationRepositoriesResponse,
  GitHubInstallationRepository,
  GitHubInstallationSummary,
} from "@janitor/domain/GitHub/Installation"

describe("GitHub installation schemas", () => {
  it("normalizes string and number account database IDs", async () => {
    const decoding = new TestSchema.Asserts(GitHubAccountDatabaseIdFromStringOrNumber).decoding()
    const expected = GitHubAccountDatabaseId.make("456")

    await decoding.succeed("456", expected)
    await decoding.succeed(456, expected)
  })

  it("rejects account IDs that cannot be represented safely", async () => {
    const decoding = new TestSchema.Asserts(GitHubAccountDatabaseIdFromNumber).decoding()

    await decoding.fail(Number.MAX_SAFE_INTEGER + 1, "Expected an integer")
  })

  it("decodes and normalizes an installation summary", async () => {
    const decoding = new TestSchema.Asserts(GitHubInstallationSummary).decoding()

    await decoding.succeed(
      {
        id: 123,
        account: { id: 456, login: "effect", type: "Organization" },
        repository_selection: "selected",
        html_url: "https://github.com/settings/installations/123",
        suspended_at: null,
      },
      {
        id: GitHubInstallationId.make("123"),
        account: {
          id: GitHubAccountDatabaseId.make("456"),
          login: "effect",
          type: "Organization",
        },
        repositorySelection: "selected",
        htmlUrl: "https://github.com/settings/installations/123",
        suspendedAt: null,
      },
    )
  })

  it("encodes an installation summary to GitHub wire keys", async () => {
    const encoding = new TestSchema.Asserts(GitHubInstallationSummary).encoding()

    await encoding.succeed(
      {
        id: GitHubInstallationId.make("123"),
        account: {
          id: GitHubAccountDatabaseId.make("456"),
          login: "effect",
          type: "Organization",
        },
        repositorySelection: "selected",
        htmlUrl: "https://github.com/settings/installations/123",
        suspendedAt: null,
      },
      {
        id: 123,
        account: { id: 456, login: "effect", type: "Organization" },
        repository_selection: "selected",
        html_url: "https://github.com/settings/installations/123",
        suspended_at: null,
      },
    )
  })

  it("round-trips an installation repository", async () => {
    const asserts = new TestSchema.Asserts(GitHubInstallationRepository)
    const repository = {
      id: GitHubRepositoryDatabaseId.make("789"),
      nodeId: GitHubRepositoryNodeId.make("R_kgDOJanitor"),
      fullName: { owner: "effect", repo: "janitor" },
      isPrivate: true,
    }

    await asserts
      .decoding()
      .succeed(
        { id: 789, node_id: "R_kgDOJanitor", full_name: "effect/janitor", private: true },
        repository,
      )
    await asserts.encoding().succeed(repository, {
      id: 789,
      node_id: "R_kgDOJanitor",
      full_name: "effect/janitor",
      private: true,
    })
    await asserts.decoding().succeed(
      { id: 789, full_name: "effect/janitor", private: true },
      {
        id: GitHubRepositoryDatabaseId.make("789"),
        fullName: { owner: "effect", repo: "janitor" },
        isPrivate: true,
      },
    )
  })

  it("decodes the installation repositories response", async () => {
    const asserts = new TestSchema.Asserts(GitHubInstallationRepositoriesResponse)
    const decoding = asserts.decoding()

    await decoding.succeed(
      {
        total_count: 1,
        repository_selection: "selected",
        repositories: [
          {
            id: 789,
            node_id: "R_kgDOJanitor",
            full_name: "effect/janitor",
            private: false,
          },
        ],
      },
      {
        totalCount: 1,
        repositorySelection: "selected",
        repositories: [
          {
            id: GitHubRepositoryDatabaseId.make("789"),
            nodeId: GitHubRepositoryNodeId.make("R_kgDOJanitor"),
            fullName: { owner: "effect", repo: "janitor" },
            isPrivate: false,
          },
        ],
      },
    )

    await decoding.succeed(
      {
        total_count: 0,
        repositories: [],
      },
      {
        totalCount: 0,
        repositories: [],
      },
    )

    await asserts
      .encoding()
      .succeed({ totalCount: 0, repositories: [] }, { total_count: 0, repositories: [] })
  })

  it("decodes an enterprise installation account", async () => {
    const asserts = new TestSchema.Asserts(GitHubInstallationSummary)
    const suspendedAt = "2026-08-28T12:00:00.000Z"
    const summary: GitHubInstallationSummary = {
      id: GitHubInstallationId.make("123"),
      account: {
        id: GitHubAccountDatabaseId.make("456"),
        slug: "acme",
        name: "Acme Corp",
        type: "Enterprise",
      },
      repositorySelection: "all",
      htmlUrl: "https://github.com/settings/installations/123",
      suspendedAt: DateTime.makeUnsafe(suspendedAt),
    }

    await asserts.decoding().succeed(
      {
        id: 123,
        account: { id: 456, slug: "acme", name: "Acme Corp" },
        repository_selection: "all",
        html_url: "https://github.com/settings/installations/123",
        suspended_at: suspendedAt,
      },
      summary,
    )
    await asserts.encoding().succeed(summary, {
      id: 123,
      account: { id: 456, slug: "acme", name: "Acme Corp" },
      repository_selection: "all",
      html_url: "https://github.com/settings/installations/123",
      suspended_at: suspendedAt,
    })
  })

  it("uses the installation summary identifier in errors", async () => {
    const making = new TestSchema.Asserts(GitHubInstallationSummary).make()

    await making.fail(null, "Expected GitHubInstallationSummary")
  })
})
