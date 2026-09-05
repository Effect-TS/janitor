import * as DateTime from "effect/DateTime"
import * as Option from "effect/Option"
import { Scene, Story } from "foldkit/test"
import { describe, expect, it } from "vite-plus/test"
import { describePlan, describeRevision } from "@/components/labeling-wire"
import * as Repositories from "@/components/repositories"
import * as PolicyEditor from "@/components/policy-editor"
import * as PolicySource from "@/components/policy-source"
import * as Menu from "@foldkit/ui/menu"

const at = DateTime.makeUnsafe("2026-09-03T14:00:00.000Z")
const one: Repositories.RepositoryOverview = {
  repositoryId: "701",
  owner: "effect",
  repo: "one",
  enabled: true,
  ruleCount: 12,
  policyCount: 8,
  access: "accessible",
  configuredRevision: 1,
  activeRevision: 1,
}
const two: Repositories.RepositoryOverview = { ...one, repositoryId: "702", repo: "two" }

const configuration: Repositories.ConfigurationView = {
  repositoryId: "701",
  configuredRevision: 1,
  activeRevision: 1,
  pendingTracks: [],
  policies: [
    {
      policyId: "p1",
      repositoryId: "701",
      name: "Base is main",
      target: "pull_request",
      description: "",
      publishedVersionId: "v1",
      publishedRevision: 1,
      publishedEvaluator: "Conditions",
      version: 2,
      createdAt: at,
      updatedAt: at,
    },
  ],
  rules: [
    {
      id: "r1",
      repositoryId: "701",
      labelId: "11",
      policyId: "p1",
      onNoMatch: "ensure-absent",
      group: null,
      priority: 0,
      enabled: true,
      labelStatus: "valid",
      version: 1,
      createdAt: at,
      updatedAt: at,
    },
  ],
  labels: [{ labelId: "11", name: "bug", availability: "available" }],
  labelFreshness: "verified",
}

const detail: Repositories.RepositoryDetail = {
  configuration,
  reconciliations: [
    {
      repositoryId: "701",
      number: 5,
      snapshotGeneration: "3",
      rulesRevision: 1,
      coveredSequence: "8",
      fingerprint: "a".repeat(64),
      createdAt: at,
      outcome: "evaluated",
      detail: "1 change planned",
      plan: {
        rules: [{ ruleId: "r1", outcome: "match", selected: true }],
        actions: [{ labelId: "11", action: "add", ruleId: "r1" }],
      },
      actions: [{ labelId: "11", action: "add", ruleId: "r1", status: "applied", detail: null }],
      completedAt: at,
    },
  ],
}

const consent: Repositories.AiConsent = {
  repositoryId: "701",
  state: "disabled",
  provider: "openai",
  model: "gpt-5.6-luna",
  activeLeases: 0,
  updatedAt: at,
}

const opened = (): Repositories.Model => ({
  ...Repositories.init().model,
  selected: Option.some("701"),
  detail: Option.some(detail),
})

describe("Repositories", () => {
  it("keeps the unsaved policy visible while searching and removes it on cancel", () => {
    const editing = Repositories.update(opened(), Repositories.Message.ClickedNewPolicy()).model
    Scene.scene(
      { update: Repositories.update, view: Repositories.view },
      Scene.given(editing),
      Scene.Mount.resolve(
        PolicySource.MountPolicySourceEditor,
        PolicySource.Message.MountedEditor(),
      ),
      Scene.type(Scene.role("textbox", { name: "Search policies" }), "no match"),
      Scene.inside(
        Scene.role("complementary", { name: "Policy library" }),
        Scene.expect(Scene.text("Untitled policy")).toExist(),
        Scene.expect(Scene.text("Unsaved")).toExist(),
      ),
      Scene.click(Scene.role("button", { name: "Cancel" })),
      Scene.Mount.expectEnded(PolicySource.MountPolicySourceEditor),
      Scene.expect(Scene.text("Unsaved")).toBeAbsent(),
    )
  })
  it("offers policy deletion in the document toolbar with confirmation", () => {
    const loading = Repositories.update(
      opened(),
      Repositories.Message.ClickedEditPolicy({ policyId: "p1" }),
    ).model
    const editing = Repositories.update(
      loading,
      Repositories.Message.GotPolicyDetail({
        detail: {
          policy: configuration.policies[0]!,
          draft: {
            target: "pull_request",
            matchesWhen: { fact: "baseRef", operator: "equals", value: "main" },
          },
          draftDiffers: false,
          published: null,
        },
      }),
    ).model
    Scene.scene(
      { update: Repositories.update, view: Repositories.view },
      Scene.given(editing),
      Scene.Mount.resolve(
        PolicySource.MountPolicySourceEditor,
        PolicySource.Message.MountedEditor(),
      ),
      Scene.inside(
        Scene.role("complementary", { name: "Policy library" }),
        Scene.expect(Scene.role("button", { name: "Delete" })).toBeAbsent(),
      ),
      Scene.click(Scene.role("button", { name: "Policy actions" })),
      Scene.Command.resolve(Menu.FocusItems, Menu.Message.CompletedFocusItems()),
      Scene.Mount.resolve(Menu.PortalMenuBackdrop, Menu.Message.CompletedPortalMenuBackdrop()),
      Scene.Mount.resolve(Menu.AnchorMenu, Menu.Message.CompletedAnchorMenu()),
      Scene.click(Scene.role("menuitem", { name: "Delete policy" })),
      Scene.expect(Scene.role("menuitem", { name: "Confirm delete" })).toExist(),
    )
  })

  it("preserves an open draft while navigating and refreshing policy metadata", () => {
    const created = Repositories.update(opened(), Repositories.Message.ClickedNewPolicy()).model
    const edited = Repositories.update(
      created,
      Repositories.Message.GotPolicyEditorMessage({
        message: PolicyEditor.Message.UpdatedName({ value: "Work in progress" }),
      }),
    ).model
    const away = Repositories.update(
      edited,
      Repositories.Message.SelectedSection({ section: "Activity" }),
    ).model
    const back = Repositories.update(
      away,
      Repositories.Message.SelectedSection({ section: "Policies" }),
    ).model
    const refreshed = Repositories.update(
      back,
      Repositories.Message.GotDetail({ repositoryId: "701", detail }),
    ).model
    expect(refreshed.panel._tag).toBe("PolicyEditor")
    if (refreshed.panel._tag === "PolicyEditor")
      expect(refreshed.panel.editor.name).toBe("Work in progress")
    expect(Repositories.update(refreshed, Repositories.Message.ClickedNewPolicy()).model).toBe(
      refreshed,
    )
  })

  it("renders a searchable policy library instead of the stacked dashboard", () => {
    Scene.scene(
      { update: Repositories.update, view: Repositories.view },
      Scene.given(opened()),
      Scene.expect(Scene.text("Base is main")).toExist(),
      Scene.type(Scene.role("textbox", { name: "Search policies" }), "not a matching policy"),
      Scene.expect(Scene.text("No policies match your search.")).toExist(),
      Scene.expect(Scene.text("Base is main")).toBeAbsent(),
      Scene.expect(Scene.role("button", { name: "New policy" })).toExist(),
      Scene.expect(Scene.text("AI classification")).toBeAbsent(),
      Scene.type(Scene.role("textbox", { name: "Search policies" }), "base"),
      Scene.expect(Scene.text("Base is main")).toExist(),
    )
  })

  it("changes sync independently and refreshes the repository list after saving", () => {
    const model = opened()
    const clicked = Repositories.update(
      model,
      Repositories.Message.ClickedToggleSync({ repositoryId: "701", enabled: false }),
    )
    expect(clicked.model).toBe(model)
    expect(clicked.commands).toMatchObject([
      { name: "SetRepositorySync", args: { repositoryId: "701", enabled: false } },
    ])
    const completed = Repositories.update(model, Repositories.Message.CompletedToggleSync())
    expect(completed.commands?.map((command) => command.name)).toEqual(["FetchRepositories"])
  })

  it("fetches the list and catalog, then loads the repository selected by navigation", () => {
    const { model, commands } = Repositories.init()
    expect(commands?.map((command) => command.name)).toEqual(["FetchRepositories", "FetchCatalog"])
    Story.story(
      Repositories.update,
      Story.given(model),
      Story.message(Repositories.Message.GotRepositories({ repositories: [one, two] })),
      Story.model((next) => expect(next.selected).toEqual(Option.none())),
      Story.message(Repositories.Message.Selected({ repositoryId: "701" })),
      Story.model((next) => expect(next.selected).toEqual(Option.some("701"))),
      Story.Command.resolve(
        Repositories.FetchDetail({ repositoryId: "701" }),
        Repositories.Message.GotDetail({ repositoryId: "701", detail }),
      ),
      Story.Command.resolve(
        Repositories.FetchConsent({ repositoryId: "701" }),
        Repositories.Message.GotConsent({ repositoryId: "701", consent }),
      ),
      Story.model((next) => {
        expect(next.detail).toEqual(Option.some(detail))
        expect(next.maybeConsent).toEqual(Option.some(consent))
        const repositories = Option.getOrThrow(next.repositories)
        expect(repositories[0]?.ruleCount).toBe(configuration.rules.length)
        expect(repositories[0]?.policyCount).toBe(configuration.policies.length)
        expect(repositories[1]).toEqual(two)
      }),
    )
  })

  it("drops a late answer for a repository that is no longer selected and closes the panel", () => {
    Story.story(
      Repositories.update,
      Story.given({ ...opened(), panel: { _tag: "LoadingPolicy", policyId: "p1" } }),
      Story.message(Repositories.Message.Selected({ repositoryId: "702" })),
      Story.model((next) => {
        expect(next.selected).toEqual(Option.some("702"))
        expect(next.detail).toEqual(Option.none())
        expect(next.panel._tag).toBe("Closed")
      }),
      Story.Command.resolve(
        Repositories.FetchDetail({ repositoryId: "702" }),
        Repositories.Message.GotDetail({ repositoryId: "701", detail }),
      ),
      Story.Command.resolve(
        Repositories.FetchConsent({ repositoryId: "702" }),
        Repositories.Message.GotConsent({ repositoryId: "701", consent }),
      ),
      Story.model((next) => {
        expect(next.detail).toEqual(Option.none())
        expect(next.maybeConsent).toEqual(Option.none())
      }),
    )
  })

  it("opens editors and the bench from the tables", () => {
    Story.story(
      Repositories.update,
      Story.given(opened()),
      Story.message(Repositories.Message.ClickedNewRule()),
      Story.model((next) => expect(next.panel._tag).toBe("RuleEditor")),
      Story.message(Repositories.Message.ClickedNewPolicy()),
      Story.model((next) => {
        expect(next.panel._tag).toBe("PolicyEditor")
        if (next.panel._tag === "PolicyEditor") {
          expect(next.panel.editor.source.referencePolicies).toEqual([
            { name: "Base is main", target: "pull_request" },
          ])
        }
      }),
    )
  })

  it("deletes only on the second press and refreshes afterwards", () => {
    Story.story(
      Repositories.update,
      Story.given(opened()),
      Story.message(Repositories.Message.ClickedDeleteRule({ ruleId: "r1", version: 1 })),
      Story.model((next) =>
        expect(next.maybeConfirmingDelete).toEqual(Option.some({ _tag: "Rule", ruleId: "r1" })),
      ),
      Story.Command.expectNone(),
      Story.message(Repositories.Message.ClickedDeleteRule({ ruleId: "r1", version: 1 })),
      Story.Command.resolve(
        Repositories.DeleteSubject({
          url: "/api/v1/repositories/701/rules/r1",
          version: 1,
          what: "rule",
        }),
        Repositories.Message.CompletedDelete({ what: "rule" }),
      ),
      Story.expectOutMessage(
        Repositories.OutMessage.Notified({
          title: "Deleted the rule",
          description: "The configuration revision advanced.",
        }),
      ),
      Story.Command.resolve(
        Repositories.FetchDetail({ repositoryId: "701" }),
        Repositories.Message.GotDetail({ repositoryId: "701", detail }),
      ),
      Story.Command.resolve(
        Repositories.FetchConsent({ repositoryId: "701" }),
        Repositories.Message.GotConsent({ repositoryId: "701", consent }),
      ),
    )
  })

  it("describes revisions and plans for people", () => {
    expect(describeRevision(configuration)).toBe("Revision 1 active")
    expect(
      describeRevision({ ...configuration, activeRevision: null, pendingTracks: ["labels"] }),
    ).toBe("Revision 1 waiting on labels")
    expect(describeRevision({ ...configuration, configuredRevision: 0 })).toBe("Nothing configured")
    expect(describePlan(detail.reconciliations[0]!.plan!, configuration)).toEqual([
      "add bug (Base is main)",
    ])
    expect(
      describePlan(
        detail.reconciliations[0]!.plan!,
        configuration,
        detail.reconciliations[0]!.actions,
      ),
    ).toEqual(["add bug (Base is main) ✓"])
  })
})
