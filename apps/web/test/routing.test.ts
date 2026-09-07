import * as DateTime from "effect/DateTime"
import * as Option from "effect/Option"
import * as Url from "foldkit/url"
import { describe, expect, it } from "vite-plus/test"
import * as Main from "@/main"
import * as Navigation from "@/navigation"
import * as Routes from "@/routes"
import * as Workspace from "@/components/workspace"
import * as PolicyEditor from "@/components/policy-editor"
import * as SyncButton from "@/components/sync-button"
import * as Connections from "@/components/repository-connections"
import type { PolicyDetail } from "@/components/labeling-wire"

const url = (path: string) => Option.getOrThrow(Url.fromString(`https://janitor.test${path}`))
const initial = (path: string) =>
  Main.init({ theme: { preferredTheme: "System", systemTheme: "Light" } }, url(path))
const send = (model: Main.Model, message: Workspace.Message) =>
  Main.update(model, Main.Message.GotWorkspaceMessage({ message }))
const land = (model: Main.Model, path: string) =>
  Main.update(
    model,
    Main.Message.GotNavigationMessage({
      message: Navigation.Message.ResolvedUrl({
        url: url(path),
        index: 1,
        allowed: true,
        requestId: model.navigation.requestId,
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
const detail: Workspace.RepositoryDetail = {
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
    Workspace.Message.GotDetail({ requestId: 1, repositoryId: "701", detail }),
  )
const editor = () =>
  send(
    loaded("/repositories/701/policies/p1").model,
    Workspace.Message.GotPolicyDetail({ detail: policy }),
  ).model

describe("application routing", () => {
  it("returns to the originating page after cancelling the connection flow", () => {
    const path = "/repositories/701/settings"
    const connected = land(loaded(path).model, Routes.connect()).model
    expect(connected.connections.returnPath).toBe(path)
    const callback = land(connected, "/repositories/connect/return").model
    const returned = land(callback, Routes.connect()).model
    const cancelled = Main.update(
      returned,
      Main.Message.GotConnectionsMessage({ message: Connections.Message.ClickedCancel() }),
    )
    expect(cancelled.commands).toMatchObject([{ name: "Navigate", args: { path } }])
  })

  it("uses the remembered repository when opening the connection flow directly", () => {
    const remembered = Main.init(
      {
        theme: { preferredTheme: "System", systemTheme: "Light" },
        lastRepositoryId: Option.some("701"),
      },
      url(Routes.connect()),
    ).model
    expect(remembered.connections.returnPath).toBe("/repositories/701")
    expect(initial(Routes.connect()).model.connections.returnPath).toBe("/")
  })

  it("does not request sync when the selected repository has sync disabled", () => {
    const model = loaded("/repositories/701/policies").model
    const disabled: Main.Model = {
      ...model,
      sync: { ...model.sync, isPolling: false },
      workspace: {
        ...model.workspace,
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
      workspace: {
        ...disabled.workspace,
        repositories: Option.map(disabled.workspace.repositories, (rows) =>
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
    const repository: Workspace.RepositoryOverview = {
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
      Workspace.Message.GotRepositories({ requestId: 0, repositories: [repository] }),
    )
    expect(remembered.commands).toMatchObject([
      { name: "Navigate", args: { path: "/repositories/701", replace: true } },
    ])
    const unavailable = send(
      { ...first, lastRepositoryId: Option.some("missing") },
      Workspace.Message.GotRepositories({ requestId: 0, repositories: [repository] }),
    )
    expect(unavailable.model.navigation.route._tag).toBe("Home")
    expect(unavailable.model.workspace.dataRepositoryId).toEqual(Option.none())
    expect(unavailable.commands ?? []).toEqual([])
  })

  it("opens Overview when switching repositories", () => {
    const model = loaded("/repositories/701/settings").model
    const changed = send(model, Workspace.Message.Selected({ repositoryId: "702" }))
    expect(changed.commands).toMatchObject([
      { name: "Navigate", args: { path: "/repositories/702" } },
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
          requestId: model.navigation.requestId - 1,
          allowed: true,
        }),
      }),
    )
    expect(next.model).toBe(model)
  })
  it("loads a direct policy link after its repository, preserving query state", () => {
    const first = initial("/repositories/701/policies/p1?q=main&item=214")
    expect(first.model.workspace.dataRepositoryId).toEqual(Option.some("701"))
    expect(first.commands).toContainEqual(
      expect.objectContaining({
        name: "FetchDetail",
        args: expect.objectContaining({ repositoryId: "701" }),
      }),
    )
    const repository = send(
      first.model,
      Workspace.Message.GotDetail({ requestId: 1, repositoryId: "701", detail }),
    )
    expect(repository.commands).toContainEqual(
      expect.objectContaining({
        name: "FetchPolicyDetail",
        args: { repositoryId: "701", policyId: "p1" },
      }),
    )
    const next = send(repository.model, Workspace.Message.GotPolicyDetail({ detail: policy }))
    expect(next.model.workspace.panel).toMatchObject({
      _tag: "PolicyEditor",
      editor: { testNumber: 214 },
    })
    expect(next.model.workspace.policySearch).toBe("main")
    expect(next.commands?.some((command) => command.name === "RunTest")).toBe(false)
  })

  it("opens new editors from direct links and reports missing rules", () => {
    expect(loaded("/repositories/701/policies/new").model.workspace.panel._tag).toBe("PolicyEditor")
    expect(loaded("/repositories/701/rules/new").model.workspace.panel._tag).toBe("RuleEditor")
    expect(loaded("/repositories/701/rules/missing").model.workspace.panel._tag).toBe("Unavailable")
  })

  it("ignores late policy success and failure after navigating to another repository", () => {
    const loading = loaded("/repositories/701/policies/p1").model
    const other = land(loading, "/repositories/702/policies").model
    expect(
      send(other, Workspace.Message.GotPolicyDetail({ detail: policy })).model.workspace.panel._tag,
    ).toBe("Closed")
    expect(
      send(
        other,
        Workspace.Message.FailedPolicyDetail({
          repositoryId: "701",
          policyId: "p1",
          reason: "Not found",
        }),
      ).model.workspace.panel._tag,
    ).toBe("Closed")
  })

  it("guards unsaved inline edits without replacing the editor before confirmation", () => {
    let model = editor()
    model = send(
      model,
      Workspace.Message.GotPolicyEditorMessage({
        message: PolicyEditor.Message.ClickedEditMetadata({ field: "name" }),
      }),
    ).model
    model = send(
      model,
      Workspace.Message.GotPolicyEditorMessage({
        message: PolicyEditor.Message.UpdatedMetadataDraft({ field: "name", value: "Unsaved" }),
      }),
    ).model
    const requested = Main.requestNavigation(model, Routes.rules({ repositoryId: "701" }))
    expect(requested.model.workspace.panel).toBe(model.workspace.panel)
    expect(requested.commands).toMatchObject([{ name: "Navigate", args: { guard: true } }])
    const cancelled = Main.update(
      requested.model,
      Main.Message.GotNavigationMessage({
        message: Navigation.Message.FinishedNavigation({ cancelled: true }),
      }),
    )
    expect(cancelled.model.workspace.panel).toBe(model.workspace.panel)
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
    expect(Workspace.hasUnsavedChanges(model.workspace)).toBe(false)
    expect(
      Main.requestNavigation(model, Routes.rules({ repositoryId: "701" })).commands,
    ).toMatchObject([{ args: { guard: false } }])
    const searched = land(model, "/repositories/701/policies/p1?q=main")
    expect(searched.model.workspace.panel).toBe(model.workspace.panel)
    expect(searched.model.workspace.policySearch).toBe("main")
  })

  it("routes policy test selection through the workspace without refreshing sync", () => {
    const model = editor()
    const selected = send(
      model,
      Workspace.Message.GotPolicyEditorMessage({
        message: PolicyEditor.Message.SelectedTestItem({ number: 42 }),
      }),
    )
    expect(selected.model.workspace.panel).toBe(model.workspace.panel)
    expect(selected.commands).toMatchObject([
      {
        name: "Navigate",
        args: { path: "/repositories/701/policies/p1?item=42", replace: true, guard: false },
      },
    ])
    expect(selected.commands).toHaveLength(1)
    const arrived = land(selected.model, "/repositories/701/policies/p1?item=42").model
    expect(arrived.workspace.panel).toMatchObject({
      _tag: "PolicyEditor",
      editor: { testNumber: 42 },
    })
  })

  it("replaces the new policy URL after saving without losing newer edits", () => {
    const model = loaded("/repositories/701/policies/new").model
    const saved = send(
      model,
      Workspace.Message.GotPolicyEditorMessage({
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
    expect(arrived.model.workspace.panel).toBe(saved.model.workspace.panel)
  })
})

describe("mutation navigation", () => {
  it("does not navigate away when another policy's deletion completes", () => {
    let model = editor()
    model = send(model, Workspace.Message.ClickedDeletePolicy({ policyId: "p1", version: 1 })).model
    model = send(model, Workspace.Message.ClickedDeletePolicy({ policyId: "p1", version: 1 })).model
    model = land(model, "/repositories/701/policies/new").model
    const result = send(
      model,
      Workspace.Message.CompletedDelete({
        repositoryId: "701",
        subjectId: "p1",
        operationId: 1,
        what: "policy",
      }),
    )
    expect(result.model.navigation.route._tag).toBe("NewPolicy")
    expect(result.model.workspace.panel._tag).toBe("PolicyEditor")
    expect(result.commands?.some((command) => command.name === "Navigate")).toBe(false)
    expect(result.model.navigation.pendingDestination).toEqual(Option.none())
  })

  it("closes the deleted document when it is still open", () => {
    let model = editor()
    model = send(model, Workspace.Message.ClickedDeletePolicy({ policyId: "p1", version: 1 })).model
    model = send(model, Workspace.Message.ClickedDeletePolicy({ policyId: "p1", version: 1 })).model
    const result = send(
      model,
      Workspace.Message.CompletedDelete({
        repositoryId: "701",
        subjectId: "p1",
        operationId: 1,
        what: "policy",
      }),
    )
    expect(result.model.workspace.panel._tag).toBe("Closed")
    expect(result.model.navigation.pendingDestination).toEqual(
      Option.some("/repositories/701/policies"),
    )
  })

  it("wakes sync monitoring after changing the sync setting", () => {
    const initial = loaded("/repositories/701/settings").model
    let model: Main.Model = {
      ...initial,
      sync: { ...initial.sync, isPolling: false },
      workspace: {
        ...initial.workspace,
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
      Workspace.Message.ClickedToggleSync({ repositoryId: "701", enabled: false }),
    ).model
    expect(Option.getOrThrow(model.workspace.repositories)[0]?.syncEnabled).toBe(false)
    const saved = send(
      model,
      Workspace.Message.CompletedToggleSync({ repositoryId: "701", operationId: 1 }),
    )
    expect(saved.model.sync.isPolling).toBe(true)
    expect(saved.commands?.some((command) => command.name === "FetchSyncSummary")).toBe(true)
  })
})

describe("rule menu routing", () => {
  it("updates the URL when Edit is chosen and navigates back to the rules table", () => {
    const rule = {
      id: "r1",
      repositoryId: "701",
      labelId: "11",
      policyId: "p1",
      onNoMatch: "preserve" as const,
      group: null,
      priority: 0,
      enabled: true,
      labelStatus: "valid" as const,
      version: 1,
      createdAt: at,
      updatedAt: at,
    }
    const base = loaded("/repositories/701/rules").model
    const model = {
      ...base,
      workspace: {
        ...base.workspace,
        detail: Option.some({
          ...detail,
          configuration: { ...detail.configuration, rules: [rule] },
        }),
      },
    }
    const edit = send(
      model,
      Workspace.Message.GotRuleMenuMessage({
        ruleId: "r1",
        message: { _tag: "SelectedItem", item: "Edit", index: 0 },
      }),
    )
    expect(edit.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Navigate",
          args: expect.objectContaining({ path: "/repositories/701/rules/r1" }),
        }),
      ]),
    )
    const opened = land(edit.model, "/repositories/701/rules/r1").model
    expect(opened.workspace.panel._tag).toBe("RuleEditor")
    const back = send(
      opened,
      Workspace.Message.GotRuleEditorMessage({ message: { _tag: "ClickedCancel" } }),
    )
    expect(back.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Navigate",
          args: expect.objectContaining({ path: "/repositories/701/rules" }),
        }),
      ]),
    )
    expect(land(back.model, "/repositories/701/rules").model.workspace.panel._tag).toBe("Closed")
    if (opened.workspace.panel._tag !== "RuleEditor") throw new Error("Expected rule editor")
    const currentEditor = opened.workspace.panel.editor
    const saving = {
      ...opened,
      workspace: {
        ...opened.workspace,
        panel: {
          _tag: "RuleEditor" as const,
          editor: {
            ...currentEditor,
            submission: {
              _tag: "Submitting" as const,
              operationId: 1,
              snapshot: currentEditor.savedSnapshot,
            },
          },
        },
      },
    }
    const completed = Workspace.Message.GotRuleEditorMessage({
      message: { _tag: "SucceededSaveRule", operationId: 1, rule },
    })
    const saved = send(saving, completed)
    expect(saved.commands).toContainEqual(
      expect.objectContaining({
        name: "Navigate",
        args: expect.objectContaining({ path: "/repositories/701/rules", guard: false }),
      }),
    )
    const newer = {
      ...saving,
      workspace: {
        ...saving.workspace,
        panel: {
          ...saving.workspace.panel,
          editor: { ...saving.workspace.panel.editor, group: "newer edit" },
        },
      },
    }
    const retained = send(newer, completed)
    expect(retained.commands?.some((command) => command.name === "Navigate")).toBe(false)
    expect(retained.model.workspace.panel).toMatchObject({
      _tag: "RuleEditor",
      editor: { group: "newer edit" },
    })
  })
})
