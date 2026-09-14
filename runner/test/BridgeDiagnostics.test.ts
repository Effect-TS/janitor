import { expect, it } from "vitest"
import { Harness } from "./support/Harness.ts"

it("session creation reports known bridge conflicts without forwarding arbitrary response text", async () => {
  let error = "stale generation"
  const harness = await Harness.start({
    secret: "test-model-secret",
    bindings: { REPOSITORY_SERVICE_TOKEN: "test-authority-secret" },
    serviceBindings: {
      REPOSITORY_AUTHORITY: async () => Response.json({ owner: "fixture", repo: "fixture" }),
      REPOSITORY_TEST_TRANSPORT: async (request) => {
        const path = new URL(request.url).pathname
        if (path === "/running") return Response.json({ running: true })
        if (path === "/meta") return Response.json({ error }, { status: 409 })
        throw new Error(`Unexpected test request: ${path}`)
      },
    },
  })
  try {
    const session = harness.session("bridge-diagnostics")
    const known = await session.create({ repositoryId: "123" }, 423)
    expect(known.message).toBe("Bridge refused GET /meta (409): stale generation")
    error = "unexpected response containing test-model-secret and test-authority-secret"
    const unknown = await session.create({ repositoryId: "123" }, 423)
    expect(unknown.message).toBe("Bridge refused GET /meta (409)")
  } finally {
    await harness.dispose()
  }
})
