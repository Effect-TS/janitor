import { assert, describe, it } from "@effect/vitest"
import * as AiError from "effect/ai/AiError"
import * as Exit from "effect/Exit"
import { loopExit } from "../src/AgentLoop.ts"

/**
 * How a loop's exit reads when the provider failed (EFF-3288): the excerpt
 * of the provider's message that goes in the log next to its category.
 */

/** The excerpt a loop whose provider rejected the request with `description` ends with. */
const excerptOf = (description: string) => {
  const end = loopExit(
    Exit.fail(
      AiError.make({
        module: "OpenAiClient",
        method: "streamText",
        reason: new AiError.InvalidRequestError({ description }),
      }),
    ),
  )
  if (end._tag !== "ProviderFailed") throw new Error(`Expected ProviderFailed, got ${end._tag}`)
  if (end.excerpt === undefined) throw new Error("The provider's message has no excerpt")
  return end.excerpt
}

describe("loopExit", () => {
  it("a provider's message is logged without the secrets it echoes, however short", () => {
    const excerpt = excerptOf(
      [
        "Bad Request: api_key=shortsecret123 is not a valid field, password: hunter2",
        "(POST https://ai.test/v1/chat/completions?token=tok42)",
        "Authorization: Bearer abc.def",
        'image "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" is not supported',
      ].join(" "),
    )

    for (const secret of ["shortsecret123", "hunter2", "tok42", "abc.def", "PHN2Zz48L3N2Zz4="])
      assert.notInclude(excerpt, secret)
    assert.include(excerpt, "Bad Request")
    assert.include(excerpt, "is not supported")
  })

  it("a provider's message is logged as one line of at most 300 characters", () => {
    const excerpt = excerptOf(`Invalid content in messages[3]:\n\n${"word ".repeat(100)}`)

    assert.notMatch(excerpt, /\n/)
    assert.isAtMost(excerpt.length, 300)
    assert.isTrue(excerpt.startsWith("Invalid content in messages[3]: word word"))
  })
})
