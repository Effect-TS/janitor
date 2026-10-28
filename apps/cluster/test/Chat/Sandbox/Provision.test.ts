import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { MULTICA_SKILL_NAME } from "../../../src/Chat/Sandbox/MulticaSkill.ts"
import {
  applyProvision,
  provisionRequest,
  sandboxEnvironment,
  type Skill,
} from "../../../src/Chat/Sandbox/Provision.ts"
import { MULTICA_SKILL } from "../../../src/Chat/Sandbox/Skills.ts"

describe("chat sandbox provisioning", () => {
  it("sets the git author and committer to Effect Bot", () => {
    assert.include(sandboxEnvironment("workspace"), {
      GIT_AUTHOR_NAME: "Effect Bot",
      GIT_AUTHOR_EMAIL: "tech-ops@effectful.co",
      GIT_COMMITTER_NAME: "Effect Bot",
      GIT_COMMITTER_EMAIL: "tech-ops@effectful.co",
    })
  })

  it.effect("a warm sandbox drops the skills its new provision no longer lists", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "janitor-chat-home-" })
      const provision = (skills: ReadonlyArray<Skill>) =>
        applyProvision({
          request: provisionRequest("workspace", skills),
          env: {},
          home,
          workspace: home,
        })

      // A repo skill on one turn, then a read that fell back to the bundled skill.
      yield* provision([
        MULTICA_SKILL,
        { name: "triage", files: [{ path: "SKILL.md", content: "" }] },
      ])
      yield* provision([MULTICA_SKILL])

      assert.deepStrictEqual(yield* fs.readDirectory(path.join(home, ".agents", "skills")), [
        MULTICA_SKILL_NAME,
      ])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})
