import * as Option from "effect/Option"
import * as Url from "foldkit/url"
import { describe, expect, it } from "vite-plus/test"
import * as Routes from "@/routes"

const parse = (path: string) =>
  Routes.parse(Option.getOrThrow(Url.fromString(`https://janitor.test${path}`)))

describe("SPA routes", () => {
  it.each([
    ["/", "Home"],
    ["/repositories/connect", "Connect"],
    ["/repositories/connect/return?state=example", "ConnectReturn"],
    ["/repositories/701", "Repository"],
    ["/repositories/701/policies", "Policies"],
    ["/repositories/701/policies/new", "NewPolicy"],
    ["/repositories/701/policies/p1", "Policy"],
    ["/repositories/701/rules", "Rules"],
    ["/repositories/701/rules/new", "NewRule"],
    ["/repositories/701/rules/r1", "Rule"],
    ["/repositories/701/activity", "Activity"],
    ["/repositories/701/settings", "Settings"],
    ["/account", "Account"],
    ["/account/slack/return?code=abc&state=xyz", "AccountReturn"],
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

  it("keeps the platform and callback parameters of an account return", () => {
    expect(parse("/account/github/return?code=abc&state=xyz")).toMatchObject({
      _tag: "AccountReturn",
      platform: "github",
      code: "abc",
      state: "xyz",
    })
    expect(parse("/account/slack/return?error=access_denied")).toMatchObject({
      _tag: "AccountReturn",
      platform: "slack",
      error: "access_denied",
    })
  })

  it.each([
    "/unknown",
    "/repositories",
    "/account/slack",
    "/repositories/701/unknown",
    "/repositories/701/policies/p1/extra",
  ])("shows not found for %s", (path) => {
    expect(parse(path)._tag).toBe("NotFound")
  })
})

it("opens the rules table for retired configuration-test links", () => {
  const route = parse("/repositories/701/rules/test")
  expect(route._tag).toBe("Rules")
  expect(Routes.path(route)).toBe("/repositories/701/rules")
})

it("uses the repository root for Overview and preserves section deep links", () => {
  expect(Routes.section(parse("/repositories/701"))).toBe("Overview")
  expect(Routes.sectionPath("701", "Overview")).toBe("/repositories/701")
  expect(Routes.section(parse("/repositories/701/policies/p1"))).toBe("Policies")
})
