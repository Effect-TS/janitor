import * as Option from "effect/Option"
import * as Url from "foldkit/url"
import { describe, expect, it } from "vite-plus/test"
import * as Navigation from "@/navigation"
import * as Routes from "@/routes"

const url = (path: string) => Option.getOrThrow(Url.fromString(`https://janitor.test${path}`))
const clean = { isSaving: false, hasUnsavedChanges: false }
const dirty = { ...clean, hasUnsavedChanges: true }
const initial = () =>
  Navigation.enter(
    Navigation.init(2),
    Routes.AppRoute.Policy({ repositoryId: "701", policyId: "p1" }),
  )

describe("navigation state", () => {
  it("guards leaving a dirty document without guarding query-only changes", () => {
    const model = initial()
    const leave = Navigation.request(model, "/repositories/701/rules", dirty)
    expect(leave.commands).toMatchObject([{ name: "Navigate", args: { guard: true, index: 2 } }])
    const search = Navigation.request(model, "/repositories/701/policies/p1?q=docs", dirty, {
      replace: true,
    })
    expect(search.commands).toMatchObject([
      { name: "Navigate", args: { guard: false, replace: true } },
    ])
    const blocked = Navigation.request(model, "/repositories/701/rules", {
      ...dirty,
      isSaving: true,
    })
    expect(blocked.model).toBe(model)
    expect(blocked.commands).toBeUndefined()
  })

  it("does not prompt twice for a destination already checked by application navigation", () => {
    const pending = Navigation.request(initial(), "/repositories/701/rules", dirty).model
    const changed = Navigation.update(
      pending,
      Navigation.Message.ChangedUrl({ url: url("/repositories/701/rules") }),
      dirty,
    )
    expect(changed.commands).toMatchObject([
      { name: "CheckHistoryNavigation", args: { guard: false, fromIndex: 2, requestId: 1 } },
    ])
    const back = Navigation.update(
      initial(),
      Navigation.Message.ChangedUrl({ url: url("/repositories/701/rules") }),
      dirty,
    )
    expect(back.commands).toMatchObject([{ name: "CheckHistoryNavigation", args: { guard: true } }])
  })

  it("emits only the latest allowed route and leaves page entry to the parent", () => {
    const first = Navigation.update(
      initial(),
      Navigation.Message.ChangedUrl({ url: url("/repositories/701/rules") }),
      clean,
    ).model
    const latest = Navigation.update(
      first,
      Navigation.Message.ChangedUrl({ url: url("/repositories/701/settings") }),
      clean,
    ).model
    const stale = Navigation.update(
      latest,
      Navigation.Message.ResolvedUrl({
        url: url("/repositories/701/rules"),
        index: 3,
        requestId: first.requestId,
        allowed: true,
      }),
      clean,
    )
    expect(stale.model).toBe(latest)
    expect(stale.outMessage).toBeUndefined()
    const accepted = Navigation.update(
      latest,
      Navigation.Message.ResolvedUrl({
        url: url("/repositories/701/settings"),
        index: 4,
        requestId: latest.requestId,
        allowed: true,
      }),
      clean,
    )
    expect(accepted.outMessage).toEqual({
      _tag: "AcceptedRoute",
      route: Routes.AppRoute.Settings({ repositoryId: "701" }),
    })
    expect(accepted.model.historyIndex).toBe(4)
    expect(accepted.model.route).toEqual(initial().route)
    expect(Navigation.enter(accepted.model, accepted.outMessage!.route).route._tag).toBe("Settings")
  })

  it("clears a cancelled destination without changing the accepted route", () => {
    const pending = Navigation.request(initial(), "/repositories/701/rules", dirty).model
    const result = Navigation.update(
      pending,
      Navigation.Message.FinishedNavigation({ cancelled: true }),
      dirty,
    )
    expect(result.model.pendingDestination).toEqual(Option.none())
    expect(result.model.route).toEqual(initial().route)
    expect(result.outMessage).toBeUndefined()
  })
})
