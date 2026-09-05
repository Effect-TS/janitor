import * as DateTime from "effect/DateTime"
import * as Option from "effect/Option"
import * as Url from "foldkit/url"
import { describe, expect, it } from "vite-plus/test"
import * as Main from "@/main"
import * as Navigation from "@/navigation"
import * as Routes from "@/routes"
import * as Repositories from "@/components/repositories"
import * as PolicyEditor from "@/components/policy-editor"
import * as SyncButton from "@/components/sync-button"
import type { PolicyDetail } from "@/components/labeling-wire"

const url = (path: string) => Option.getOrThrow(Url.fromString(`https://janitor.test${path}`))
const initial = (path: string) =>
  Main.init({ theme: { preferredTheme: "System", systemTheme: "Light" } }, url(path))
const send = (model: Main.Model, message: Repositories.Message) =>
  Main.update(model, Main.Message.GotRepositoriesMessage({ message }))
const land = (model: Main.Model, path: string) =>
  Main.update(
    model,
    Main.Message.GotNavigationMessage({
      message: Navigation.Message.ResolvedUrl({
        url: url(path),
        index: 1,
        allowed: true,
        requestId: model.navigationRequestId,
      }),
    }),
  )
const at = DateTime.makeUnsafe("2026-09-05T12:00:00Z")
const policy: PolicyDetail = {
  policy: {
    policyId: "p1",
    repositoryId: "701",
    name: "Targets main",
    description: "Main branch",
    target: "pull_request",
    publishedVersionId: null,
    publishedRevision: null,
    version: 1,
    createdAt: at,
    updatedAt: at,
  },
  draft: {
    target: "pull_request",
    matchesWhen: { fact: "baseRef", operator: "equals", value: "main" },
  },
  draftDiffers: true,
  published: null,
}
const detail: Repositories.RepositoryDetail = {
  configuration: {
    repositoryId: "701",
    configuredRevision: 1,
    activeRevision: 1,
    pendingTracks: [],
    policies: [policy.policy],
    rules: [],
    labels: [],
    labelFreshness: "verified",
  },
  reconciliations: [],
}
const loaded = (path: string) =>
  send(
    initial(path).model,
    Repositories.Message.GotDetail({ requestId: 1, repositoryId: "701", detail }),
  )
const editor = () =>
  send(
    loaded("/repositories/701/policies/p1").model,
    Repositories.Message.GotPolicyDetail({ detail: policy }),
  ).model

describe("application routing", () => {
  it("does not request sync when the selected repository has sync disabled", () => {
    const model = loaded("/repositories/701/policies").model
    const disabled: Main.Model = {
      ...model,
      sync: { ...model.sync, isPolling: false },
      repositories: {
        ...model.repositories,
        repositories: Option.some([
          {
            repositoryId: "701",
            owner: "Example",
            repo: "project",
            access: "accessible",
            enabled: true,
            syncEnabled: false,
            ruleCount: 0,
            policyCount: 1,
            configuredRevision: 1,
            activeRevision: 1,
          },
        ]),
      },
    }
    expect(
      Main.update(
        disabled,
        Main.Message.GotSyncButtonMessage({ message: SyncButton.Message.PressedSync() }),
      ).commands ?? [],
    ).toEqual([])
    const enabled = {
      ...disabled,
      repositories: {
        ...disabled.repositories,
        repositories: Option.map(disabled.repositories.repositories, (rows) =>
          rows.map((row) => ({ ...row, syncEnabled: true })),
        ),
      },
    }
    expect(
      Main.update(
        enabled,
        Main.Message.GotSyncButtonMessage({ message: SyncButton.Message.PressedSync() }),
      ).commands,
    ).toHaveLength(1)
  })
  it("redirects root to a remembered accessible repository and otherwise keeps the chooser", () => {
    const first = initial("/").model
    const repository: Repositories.RepositoryOverview = {
      repositoryId: "701",
      owner: "Example",
      repo: "project",
      access: "accessible",
      enabled: true,
      ruleCount: 0,
      policyCount: 1,
      configuredRevision: 1,
      activeRevision: 1,
    }
    const remembered = send(
      { ...first, lastRepositoryId: Option.some("701") },
      Repositories.Message.GotRepositories({ requestId: 0, repositories: [repository] }),
    )
    expect(remembered.commands).toMatchObject([
      { name: "Navigate", args: { path: "/repositories/701/policies", replace: true } },
    ])
    const unavailable = send(
      { ...first, lastRepositoryId: Option.some("missing") },
      Repositories.Message.GotRepositories({ requestId: 0, repositories: [repository] }),
    )
    expect(unavailable.model.route._tag).toBe("Home")
    expect(unavailable.model.repositories.selected).toEqual(Option.none())
    expect(unavailable.commands ?? []).toEqual([])
  })

  it("preserves the current section when switching repositories", () => {
    const model = loaded("/repositories/701/settings").model
    const changed = send(model, Repositories.Message.Selected({ repositoryId: "702" }))
    expect(changed.commands).toMatchObject([
      { name: "Navigate", args: { path: "/repositories/702/settings" } },
    ])
  })

  it("ignores obsolete navigation checks", () => {
    const model = editor()
    const next = Main.update(
      model,
      Main.Message.GotNavigationMessage({
        message: Navigation.Message.ResolvedUrl({
          url: url("/repositories/701/rules"),
          index: 9,
          requestId: model.navigationRequestId - 1,
          allowed: true,
        }),
      }),
    )
    expect(next.model).toBe(model)
  })
  it("loads a direct policy link after its repository, preserving query state", () => {
    const first = initial("/repositories/701/policies/p1?q=main&item=214")
    expect(first.model.repositories.selected).toEqual(Option.some("701"))
    expect(first.commands).toContainEqual(
      expect.objectContaining({
        name: "FetchDetail",
        args: expect.objectContaining({ repositoryId: "701" }),
      }),
    )
    const repository = send(
      first.model,
      Repositories.Message.GotDetail({ requestId: 1, repositoryId: "701", detail }),
    )
    expect(repository.commands).toContainEqual(
      expect.objectContaining({
        name: "FetchPolicyDetail",
        args: { repositoryId: "701", policyId: "p1" },
      }),
    )
    const next = send(repository.model, Repositories.Message.GotPolicyDetail({ detail: policy }))
    expect(next.model.repositories.panel).toMatchObject({
      _tag: "PolicyEditor",
      editor: { testNumber: 214 },
    })
    expect(next.model.repositories.policySearch).toBe("main")
    expect(next.commands?.some((command) => command.name === "RunTest")).toBe(false)
  })

  it("opens new editors from direct links and reports missing rules", () => {
    expect(loaded("/repositories/701/policies/new").model.repositories.panel._tag).toBe(
      "PolicyEditor",
    )
    expect(loaded("/repositories/701/rules/new").model.repositories.panel._tag).toBe("RuleEditor")
    expect(loaded("/repositories/701/rules/missing").model.repositories.panel._tag).toBe(
      "Unavailable",
    )
  })

  it("ignores late policy success and failure after navigating to another repository", () => {
    const loading = loaded("/repositories/701/policies/p1").model
    const other = land(loading, "/repositories/702/policies").model
    expect(
      send(other, Repositories.Message.GotPolicyDetail({ detail: policy })).model.repositories.panel
        ._tag,
    ).toBe("Closed")
    expect(
      send(
        other,
        Repositories.Message.FailedPolicyDetail({
          repositoryId: "701",
          policyId: "p1",
          reason: "Not found",
        }),
      ).model.repositories.panel._tag,
    ).toBe("Closed")
  })

  it("guards unsaved inline edits without replacing the editor before confirmation", () => {
    let model = editor()
    model = send(
      model,
      Repositories.Message.GotPolicyEditorMessage({
        message: PolicyEditor.Message.ClickedEditMetadata({ field: "name" }),
      }),
    ).model
    model = send(
      model,
      Repositories.Message.GotPolicyEditorMessage({
        message: PolicyEditor.Message.UpdatedMetadataDraft({ field: "name", value: "Unsaved" }),
      }),
    ).model
    const requested = Main.requestNavigation(model, Routes.rules({ repositoryId: "701" }))
    expect(requested.model.repositories.panel).toBe(model.repositories.panel)
    expect(requested.commands).toMatchObject([{ name: "Navigate", args: { guard: true } }])
    const cancelled = Main.update(
      requested.model,
      Main.Message.GotNavigationMessage({
        message: Navigation.Message.FinishedNavigation({ cancelled: true }),
      }),
    )
    expect(cancelled.model.repositories.panel).toBe(model.repositories.panel)
    const back = Main.update(
      model,
      Main.Message.GotNavigationMessage({
        message: Navigation.Message.ChangedUrl({ url: url("/repositories/701/rules") }),
      }),
    )
    expect(back.commands).toMatchObject([{ name: "CheckHistoryNavigation", args: { guard: true } }])
  })

  it("does not warn about an unchanged saved draft and preserves editor state on query changes", () => {
    const model = editor()
    expect(Repositories.hasUnsavedChanges(model.repositories)).toBe(false)
    expect(
      Main.requestNavigation(model, Routes.rules({ repositoryId: "701" })).commands,
    ).toMatchObject([{ args: { guard: false } }])
    const searched = land(model, "/repositories/701/policies/p1?q=main")
    expect(searched.model.repositories.panel).toBe(model.repositories.panel)
    expect(searched.model.repositories.policySearch).toBe("main")
  })

  it("replaces the new policy URL after saving without losing newer edits", () => {
    const model = loaded("/repositories/701/policies/new").model
    const saved = send(
      model,
      Repositories.Message.GotPolicyEditorMessage({
        message: PolicyEditor.Message.SucceededSavePolicy({ detail: policy, published: false }),
      }),
    )
    expect(saved.commands).toContainEqual(
      expect.objectContaining({
        name: "Navigate",
        args: expect.objectContaining({
          path: "/repositories/701/policies/p1",
          replace: true,
          guard: false,
        }),
      }),
    )
    const arrived = land(saved.model, "/repositories/701/policies/p1")
    expect(arrived.model.repositories.panel).toBe(saved.model.repositories.panel)
  })
})

describe("mutation navigation", () => {
  it("does not navigate away when another policy's deletion completes", () => {
    let model = editor()
    model = send(
      model,
      Repositories.Message.ClickedDeletePolicy({ policyId: "p1", version: 1 }),
    ).model
    model = send(
      model,
      Repositories.Message.ClickedDeletePolicy({ policyId: "p1", version: 1 }),
    ).model
    model = land(model, "/repositories/701/policies/new").model
    const result = send(
      model,
      Repositories.Message.CompletedDelete({
        repositoryId: "701",
        subjectId: "p1",
        operationId: 1,
        what: "policy",
      }),
    )
    expect(result.model.route._tag).toBe("NewPolicy")
    expect(result.model.repositories.panel._tag).toBe("PolicyEditor")
    expect(result.commands?.some((command) => command.name === "Navigate")).toBe(false)
    expect(result.model.navigationTarget).toEqual(Option.none())
  })

  it("closes the deleted document when it is still open", () => {
    let model = editor()
    model = send(
      model,
      Repositories.Message.ClickedDeletePolicy({ policyId: "p1", version: 1 }),
    ).model
    model = send(
      model,
      Repositories.Message.ClickedDeletePolicy({ policyId: "p1", version: 1 }),
    ).model
    const result = send(
      model,
      Repositories.Message.CompletedDelete({
        repositoryId: "701",
        subjectId: "p1",
        operationId: 1,
        what: "policy",
      }),
    )
    expect(result.model.repositories.panel._tag).toBe("Closed")
    expect(result.model.navigationTarget).toEqual(Option.some("/repositories/701/policies"))
  })

  it("wakes sync monitoring after changing the sync setting", () => {
    const initial = loaded("/repositories/701/settings").model
    let model: Main.Model = {
      ...initial,
      sync: { ...initial.sync, isPolling: false },
      repositories: {
        ...initial.repositories,
        repositories: Option.some([
          {
            repositoryId: "701",
            owner: "test",
            repo: "repo",
            access: "accessible",
            enabled: true,
            syncEnabled: true,
            policyCount: 1,
            ruleCount: 0,
            configuredRevision: 1,
            activeRevision: 1,
          },
        ]),
      },
    }
    model = send(
      model,
      Repositories.Message.ClickedToggleSync({ repositoryId: "701", enabled: false }),
    ).model
    expect(Option.getOrThrow(model.repositories.repositories)[0]?.syncEnabled).toBe(false)
    const saved = send(
      model,
      Repositories.Message.CompletedToggleSync({ repositoryId: "701", operationId: 1 }),
    )
    expect(saved.model.sync.isPolling).toBe(true)
    expect(saved.commands?.some((command) => command.name === "FetchSyncSummary")).toBe(true)
  })
})
