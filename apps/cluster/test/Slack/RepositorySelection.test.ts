import { assert, describe, it } from "vite-plus/test"
import { selectRepository } from "../../src/Slack/RepositorySelection.ts"

const repositories = [
  { repository_id: "1", owner: "Effect-TS", repo: "effect" },
  { repository_id: "2", owner: "Effect-TS", repo: "platform" },
  { repository_id: "3", owner: "other", repo: "effect" },
]
describe("repository selection", () => {
  it("honors explicit owners and retains a PR through repository-only follow-ups", () => {
    assert.deepInclude(
      selectRepository(
        ["https://github.com/other/effect/pull/07", "Use other/effect", "Edit src/components"],
        repositories,
        "Effect-TS",
      ),
      { repositoryId: "3", pr: "7" },
    )
    assert.deepInclude(selectRepository(["Fix effect"], repositories, "Effect-TS"), {
      repositoryId: "1",
    })
    assert.deepInclude(selectRepository(["Fix effect"], repositories, "other"), {
      repositoryId: "3",
    })
  })
  it("does not choose an arbitrary repository or override contradictory explicit references", () => {
    assert.deepInclude(selectRepository(["Use missing/effect"], repositories, "Effect-TS"), {
      kind: "clarification",
    })
    assert.isNull(selectRepository(["Work in Effect-TS"], repositories, "Effect-TS"))
    assert.isNull(selectRepository(["Make it effectively faster"], repositories, "Effect-TS"))
    assert.deepInclude(
      selectRepository(["Effect-TS/effect and other/effect"], repositories, "Effect-TS"),
      { kind: "clarification" },
    )
    assert.deepInclude(
      selectRepository(["https://github.com/missing/project"], repositories, "Effect-TS"),
      { kind: "clarification" },
    )
    assert.deepInclude(
      selectRepository(
        ["Effect-TS/effect and other/effect", "Use other/effect"],
        repositories,
        "Effect-TS",
      ),
      { repositoryId: "3" },
    )
    assert.deepInclude(
      selectRepository(
        ["Effect-TS/effect/pull/1 and Effect-TS/effect/pull/2"],
        repositories,
        "Effect-TS",
      ),
      { kind: "clarification" },
    )
  })
})
