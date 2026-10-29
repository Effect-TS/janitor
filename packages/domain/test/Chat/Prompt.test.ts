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
    assert.include(prompt, "Delegate larger work to the Effect Bot squad in Multica")
    assert.include(prompt, "adversarial review and simplification happen in separate runs")
    assert.include(prompt, "Before starting larger work, propose a Multica issue")
    assert.include(prompt, "hand off through that issue rather than implementing it in this chat")
  })
})
