import { assert, describe, it } from "@effect/vitest"
import { sandboxEnvironment } from "../../../src/Chat/Sandbox/Provision.ts"

describe("chat sandbox provisioning", () => {
  it("sets the git author and committer to Effect Bot", () => {
    assert.include(sandboxEnvironment("workspace"), {
      GIT_AUTHOR_NAME: "Effect Bot",
      GIT_AUTHOR_EMAIL: "tech-ops@effectful.co",
      GIT_COMMITTER_NAME: "Effect Bot",
      GIT_COMMITTER_EMAIL: "tech-ops@effectful.co",
    })
  })
})
