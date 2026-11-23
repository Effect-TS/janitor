import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import * as AgentSkills from "clanka/AgentSkills"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import {
  applyProvision,
  provisionRequest,
  sandboxEnvironment,
} from "../../../src/Chat/Sandbox/Provision.ts"

describe("chat sandbox provisioning", () => {
  it("sets the git author and committer to Effect Bot", () => {
    assert.include(sandboxEnvironment("workspace"), {
      GIT_AUTHOR_NAME: "Effect Bot",
      GIT_AUTHOR_EMAIL: "tech-ops@effectful.co",
      GIT_COMMITTER_NAME: "Effect Bot",
      GIT_COMMITTER_EMAIL: "tech-ops@effectful.co",
    })
  })

  it.effect("writes skills where clanka discovers them", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "janitor-chat-provision-" })
      const home = path.join(root, "home")
      const workspace = path.join(root, "workspace")

      yield* applyProvision({
        request: provisionRequest("workspace", [
          {
            name: "issue-fix",
            files: [
              {
                path: "SKILL.md",
                content:
                  "---\nname: issue-fix\ndescription: Read this before filing an issue\n---\n\n# Issue fix\n",
              },
            ],
          },
        ]),
        env: {},
        home,
        workspace,
      })

      const skills = yield* AgentSkills.discover({
        directory: workspace,
        homeDirectory: Option.some(home),
      })

      assert.strictEqual(skills.find((skill) => skill.name === "issue-fix")?.source, "user")
    }).pipe(Effect.provide(NodeServices.layer)),
  )
})
