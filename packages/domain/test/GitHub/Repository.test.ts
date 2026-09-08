import { describe, it } from "@effect/vitest"
import { TestSchema } from "effect/testing"
import {
  GitHubInstallationId,
  GitHubInstallationIdFromStringOrNumber,
  GitHubRepositoryDatabaseId,
  GitHubRepositoryDatabaseIdFromStringOrNumber,
} from "@janitor/domain/GitHub/Id"
import { GitHubRepositoryFullNameFromString } from "@janitor/domain/GitHub/Repository"

describe("GitHub repository schemas", () => {
  it("decodes a repository full name", async () => {
    const decoding = new TestSchema.Asserts(GitHubRepositoryFullNameFromString).decoding()

    await decoding.succeed("effect/janitor", {
      owner: "effect",
      repo: "janitor",
    })

    await decoding.fail("effect/janitor/extra", "Expected a string matching template literal parts")
  })

  it("encodes a repository full name", async () => {
    const encoding = new TestSchema.Asserts(GitHubRepositoryFullNameFromString).encoding()

    await encoding.succeed({ owner: "effect", repo: "janitor" }, "effect/janitor")
  })

  it("normalizes string and number repository database IDs", async () => {
    const decoding = new TestSchema.Asserts(GitHubRepositoryDatabaseIdFromStringOrNumber).decoding()
    const expected = GitHubRepositoryDatabaseId.make("123")

    await decoding.succeed("123", expected)
    await decoding.succeed(123, expected)
  })

  it("normalizes string and number installation IDs", async () => {
    const decoding = new TestSchema.Asserts(GitHubInstallationIdFromStringOrNumber).decoding()
    const expected = GitHubInstallationId.make("456")

    await decoding.succeed("456", expected)
    await decoding.succeed(456, expected)
  })
})
