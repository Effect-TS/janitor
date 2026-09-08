import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import {
  GitHubLabelDatabaseId,
  GitHubLabelDatabaseIdFromStringOrNumber,
  GitHubPullRequestNodeId,
  GitHubRepositoryDatabaseId,
  GitHubRepositoryDatabaseIdFromStringOrNumber,
} from "@janitor/domain/GitHub/Id"

describe("GitHub IDs", () => {
  it.effect("normalizes safe numeric database IDs to branded decimal strings", () =>
    Effect.gen(function* () {
      const repositoryId = yield* Schema.decodeUnknownEffect(
        GitHubRepositoryDatabaseIdFromStringOrNumber,
      )(123)
      const labelId = yield* Schema.decodeUnknownEffect(GitHubLabelDatabaseIdFromStringOrNumber)(
        "456",
      )

      assert.strictEqual(repositoryId, GitHubRepositoryDatabaseId.make("123"))
      assert.strictEqual(labelId, GitHubLabelDatabaseId.make("456"))
      assert.strictEqual(
        yield* Schema.encodeEffect(GitHubRepositoryDatabaseIdFromStringOrNumber)(repositoryId),
        123,
      )
    }),
  )

  it.effect("rejects unsafe numeric and malformed decimal IDs", () =>
    Effect.gen(function* () {
      for (const input of [Number.MAX_SAFE_INTEGER + 1, 0, -1, "0", "01", "1.5", "abc"]) {
        const exit = yield* Schema.decodeUnknownEffect(
          GitHubRepositoryDatabaseIdFromStringOrNumber,
        )(input).pipe(Effect.exit)

        assert.isTrue(Exit.isFailure(exit))
      }
    }),
  )

  it.effect("accepts lossless decimal strings beyond the safe integer range", () =>
    Effect.gen(function* () {
      const input = "9007199254740993"
      const id = yield* Schema.decodeUnknownEffect(GitHubRepositoryDatabaseIdFromStringOrNumber)(
        input,
      )

      assert.strictEqual(id, GitHubRepositoryDatabaseId.make(input))
      assert.strictEqual(
        yield* Schema.encodeEffect(GitHubRepositoryDatabaseIdFromStringOrNumber)(id),
        input,
      )
    }),
  )

  it.effect("rejects empty node IDs", () =>
    Schema.decodeUnknownEffect(GitHubPullRequestNodeId)("").pipe(
      Effect.exit,
      Effect.map((exit) => assert.isTrue(Exit.isFailure(exit))),
    ),
  )
})
