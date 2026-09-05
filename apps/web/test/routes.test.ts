import * as Option from "effect/Option"
import * as Url from "foldkit/url"
import { describe, expect, it } from "vite-plus/test"
import * as Routes from "@/routes"

const parse = (path: string) =>
  Routes.parse(Option.getOrThrow(Url.fromString(`https://janitor.test${path}`)))

describe("SPA routes", () => {
  it.each([
    ["/", "Home"],
    ["/repositories/701", "Repository"],
    ["/repositories/701/policies", "Policies"],
    ["/repositories/701/policies/new", "NewPolicy"],
    ["/repositories/701/policies/p1", "Policy"],
    ["/repositories/701/rules", "Rules"],
    ["/repositories/701/rules/new", "NewRule"],
    ["/repositories/701/rules/test", "TestRules"],
    ["/repositories/701/rules/r1", "Rule"],
    ["/repositories/701/activity", "Activity"],
    ["/repositories/701/settings", "Settings"],
  ])("round-trips %s without confusing reserved paths with IDs", (path, tag) => {
    const route = parse(path)
    expect(route._tag).toBe(tag)
    expect(Routes.path(route)).toBe(path)
  })

  it("round-trips search and selected test item without changing document identity", () => {
    const path = Routes.policy({
      repositoryId: "701",
      policyId: "p 1",
      q: "docs & tests",
      item: "214",
    })
    const route = parse(path)
    expect(route).toMatchObject({ _tag: "Policy", policyId: "p 1", q: "docs & tests", item: "214" })
    expect(Routes.documentPath(route)).toBe(Routes.policy({ repositoryId: "701", policyId: "p 1" }))
  })

  it.each([
    "/unknown",
    "/repositories",
    "/repositories/701/unknown",
    "/repositories/701/policies/p1/extra",
  ])("shows not found for %s", (path) => {
    expect(parse(path)._tag).toBe("NotFound")
  })
})
