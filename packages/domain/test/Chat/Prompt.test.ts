import { assert, describe, it } from "@effect/vitest"
import { systemPrompt } from "@janitor/domain/Chat/Prompt"

describe("systemPrompt", () => {
  it("gives the Multica issue URL format for the configured workspace slug", () => {
    const prompt = systemPrompt({
      audience: "slack",
      multicaWorkspaceId: "6eac4221-824e-4b2f-8517-546454766676",
      multicaWorkspaceSlug: "acme-1234",
    })

    assert.include(prompt, "https://multica.ai/acme-1234/issues/<identifier>")
  })
})
