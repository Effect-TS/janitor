import { expect, it } from "vite-plus/test"
import { Harness } from "./support/Harness.ts"

it("reports repository HTTP failures without forwarding credential-bearing response text", async () => {
  const harness = await Harness.start({
    secret: "test-model-secret",
    bindings: { REPOSITORY_SERVICE_TOKEN: "test-authority-secret" },
    serviceBindings: {
      REPOSITORY_AUTHORITY: async () =>
        Response.json({ owner: "fixture", repo: "fixture", token: "repo-secret" }),
      GITHUB_API: async () =>
        Response.json({ error: "repo-secret and test-model-secret" }, { status: 403 }),
    },
  })
  try {
    const result = await harness
      .session("repository-diagnostics")
      .create({ repositoryId: "123" }, 423)
    expect(result.message).toContain("GitHub repository operation failed (403)")
    expect(JSON.stringify(result)).not.toContain("repo-secret")
    expect(JSON.stringify(result)).not.toContain("test-model-secret")
  } finally {
    await harness.dispose()
  }
})
