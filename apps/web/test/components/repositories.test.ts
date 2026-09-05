import * as RuleEditor from "@/components/rule-editor"
import { RuleRecord } from "@/components/labeling-wire"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
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
  repositories: Option.some([one, two]),
  maybeDetailRequest: Option.some(1),
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
      Repositories.Message.GotDetail({ requestId: 1, repositoryId: "701", detail }),
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
    expect(Option.getOrThrow(clicked.model.repositories)[0]?.syncEnabled).toBe(false)
    expect(clicked.commands).toMatchObject([
      { name: "SetRepositorySync", args: { repositoryId: "701", enabled: false } },
    ])
    const completed = Repositories.update(
      clicked.model,
      Repositories.Message.CompletedToggleSync({ repositoryId: "701", operationId: 1 }),
    )
    expect(completed.commands?.map((command) => command.name)).toEqual(["FetchRepositories"])
  })

  it("fetches the list and catalog, then loads the repository selected by navigation", () => {
    const { model, commands } = Repositories.init()
    expect(commands?.map((command) => command.name)).toEqual(["FetchRepositories", "FetchCatalog"])
    Story.story(
      Repositories.update,
      Story.given(model),
      Story.message(
        Repositories.Message.GotRepositories({ requestId: 0, repositories: [one, two] }),
      ),
      Story.model((next) => expect(next.selected).toEqual(Option.none())),
      Story.message(Repositories.Message.Selected({ repositoryId: "701" })),
      Story.model((next) => expect(next.selected).toEqual(Option.some("701"))),
      Story.Command.resolve(
        Repositories.FetchDetail({ requestId: 1, repositoryId: "701" }),
        Repositories.Message.GotDetail({ requestId: 1, repositoryId: "701", detail }),
      ),
      Story.Command.resolve(
        Repositories.FetchConsent({ requestId: 2, repositoryId: "701" }),
        Repositories.Message.GotConsent({ requestId: 2, repositoryId: "701", consent }),
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
        Repositories.FetchDetail({ requestId: 1, repositoryId: "702" }),
        Repositories.Message.GotDetail({ requestId: 1, repositoryId: "701", detail }),
      ),
      Story.Command.resolve(
        Repositories.FetchConsent({ requestId: 2, repositoryId: "702" }),
        Repositories.Message.GotConsent({ requestId: 2, repositoryId: "701", consent }),
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
          repositoryId: "701",
          subjectId: "r1",
          operationId: 1,
          url: "/api/v1/repositories/701/rules/r1",
          version: 1,
          what: "rule",
        }),
        Repositories.Message.CompletedDelete({
          what: "rule",
          repositoryId: "701",
          subjectId: "r1",
          operationId: 1,
        }),
      ),
      Story.expectOutMessage(
        Repositories.OutMessage.Notified({
          title: "Deleted the rule",
          description: "The list has been updated.",
        }),
      ),
      Story.Command.resolve(
        Repositories.FetchDetail({ requestId: 1, repositoryId: "701" }),
        Repositories.Message.GotDetail({ requestId: 1, repositoryId: "701", detail }),
      ),
      Story.Command.resolve(
        Repositories.FetchConsent({ requestId: 2, repositoryId: "701" }),
        Repositories.Message.GotConsent({ requestId: 2, repositoryId: "701", consent }),
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

const ready = (): Repositories.Model => {
  const listed = Repositories.update(
    Repositories.init().model,
    Repositories.Message.GotRepositories({ requestId: 0, repositories: [one, two] }),
  ).model
  const selected = Repositories.update(
    listed,
    Repositories.Message.Selected({ repositoryId: "701" }),
  ).model
  return Repositories.update(
    selected,
    Repositories.Message.GotDetail({ repositoryId: "701", requestId: 1, detail }),
  ).model
}

describe("mutation reconciliation", () => {
  it("toggles a rule immediately, serializes its writes, and rolls back only that field", () => {
    const clicked = Repositories.update(
      ready(),
      Repositories.Message.ClickedToggleRule({ ruleId: "r1" }),
    )
    expect(Option.getOrThrow(clicked.model.detail).configuration.rules[0]?.enabled).toBe(false)
    expect(
      Repositories.update(clicked.model, Repositories.Message.ClickedToggleRule({ ruleId: "r1" }))
        .commands,
    ).toBeUndefined()
    expect(
      Repositories.update(
        clicked.model,
        Repositories.Message.ClickedDeleteRule({ ruleId: "r1", version: 1 }),
      ).commands,
    ).toBeUndefined()
    const changed = { ...clicked.model, policySearch: "keep this" }
    const failed = Repositories.update(
      changed,
      Repositories.Message.FailedToggleRule({
        repositoryId: "701",
        ruleId: "r1",
        operationId: 1,
        reason: "Conflict",
      }),
    )
    expect(Option.getOrThrow(failed.model.detail).configuration.rules[0]?.enabled).toBe(true)
    expect(failed.model.policySearch).toBe("keep this")
    expect(failed.model.pendingMutations).toEqual([])
    expect(failed.commands?.some((command) => command.name === "FetchDetail")).toBe(true)
  })

  it("preserves optimistic values during polling and rejects a response from before the successful write", () => {
    const poll = Repositories.update(ready(), Repositories.Message.Polled())
    const oldRequest = Option.getOrThrow(poll.model.maybeDetailRequest)
    const clicked = Repositories.update(
      poll.model,
      Repositories.Message.ClickedToggleRule({ ruleId: "r1" }),
    )
    const polled = Repositories.update(
      clicked.model,
      Repositories.Message.GotDetail({ repositoryId: "701", requestId: oldRequest, detail }),
    )
    expect(Option.getOrThrow(polled.model.detail).configuration.rules[0]?.enabled).toBe(false)
    const rule = { ...configuration.rules[0]!, enabled: false, version: 2 }
    const saved = Repositories.update(
      polled.model,
      Repositories.Message.CompletedToggleRule({ repositoryId: "701", operationId: 1, rule }),
    )
    expect(Option.getOrThrow(saved.model.detail).configuration.rules[0]).toEqual(rule)
    expect(saved.outMessage?._tag).toBe("SyncWorkChanged")
    const obsolete = Repositories.update(
      saved.model,
      Repositories.Message.GotDetail({ repositoryId: "701", requestId: oldRequest, detail }),
    )
    expect(obsolete.model).toBe(saved.model)
    expect(
      Repositories.update(saved.model, Repositories.Message.Polled()).commands?.filter(
        (command) => command.name === "FetchDetail",
      ),
    ).toHaveLength(0)
  })

  it("makes sync settings visible immediately and rejects obsolete list results", () => {
    const polling = Repositories.refreshRepositories(ready())
    const clicked = Repositories.update(
      polling.model,
      Repositories.Message.ClickedToggleSync({ repositoryId: "701", enabled: false }),
    )
    expect(Option.getOrThrow(clicked.model.repositories)[0]?.syncEnabled).toBe(false)
    const pendingList = Repositories.update(
      clicked.model,
      Repositories.Message.GotRepositories({
        requestId: Option.getOrThrow(polling.model.maybeRepositoriesRequest),
        repositories: [one, two],
      }),
    )
    expect(Option.getOrThrow(pendingList.model.repositories)[0]?.syncEnabled).toBe(false)
    const saved = Repositories.update(
      pendingList.model,
      Repositories.Message.CompletedToggleSync({ repositoryId: "701", operationId: 1 }),
    )
    const oldList = Repositories.update(
      saved.model,
      Repositories.Message.GotRepositories({
        requestId: Option.getOrThrow(polling.model.maybeRepositoriesRequest),
        repositories: [one, two],
      }),
    )
    expect(oldList.model).toBe(saved.model)
  })

  it("removes a deleted policy immediately without closing another policy", () => {
    const first = Repositories.update(
      ready(),
      Repositories.Message.ClickedDeletePolicy({ policyId: "p1", version: 2 }),
    ).model
    const deleting = Repositories.update(
      first,
      Repositories.Message.ClickedDeletePolicy({ policyId: "p1", version: 2 }),
    ).model
    expect(deleting.pendingMutations[0]?.kind).toBe("PolicyDelete")
    const openedOther = Repositories.update(deleting, Repositories.Message.ClickedNewPolicy()).model
    const completed = Repositories.update(
      openedOther,
      Repositories.Message.CompletedDelete({
        repositoryId: "701",
        subjectId: "p1",
        what: "policy",
        operationId: 1,
      }),
    )
    expect(completed.model.panel._tag).toBe("PolicyEditor")
    expect(Option.getOrThrow(completed.model.detail).configuration.policies).toEqual([])
    expect(Option.getOrThrow(completed.model.repositories)[0]?.policyCount).toBe(0)
    expect(
      Repositories.update(
        completed.model,
        Repositories.Message.CompletedDelete({
          repositoryId: "701",
          subjectId: "p1",
          what: "policy",
          operationId: 1,
        }),
      ).model,
    ).toBe(completed.model)
  })

  it("keeps a rejected deletion visible and reports the server reason", () => {
    const first = Repositories.update(
      ready(),
      Repositories.Message.ClickedDeletePolicy({ policyId: "p1", version: 2 }),
    ).model
    const deleting = Repositories.update(
      first,
      Repositories.Message.ClickedDeletePolicy({ policyId: "p1", version: 2 }),
    ).model
    const failed = Repositories.update(
      deleting,
      Repositories.Message.FailedDelete({
        repositoryId: "701",
        subjectId: "p1",
        operationId: 1,
        reason: "Retained history uses this policy",
      }),
    )
    expect(Option.getOrThrow(failed.model.detail).configuration.policies).toHaveLength(1)
    expect(failed.model.pendingMutations).toEqual([])
    expect(failed.outMessage).toMatchObject({
      _tag: "Failed",
      reason: "Retained history uses this policy",
    })
  })

  it("keeps consent errors recoverable and pending consent scoped to its repository", () => {
    const failed = Repositories.update(
      ready(),
      Repositories.Message.FailedConsent({ repositoryId: "701", requestId: 2, reason: "Offline" }),
    )
    expect(failed.model.consentError).toEqual(Option.some("Offline"))
    const retry = Repositories.update(failed.model, Repositories.Message.ClickedRetryConsent())
    const loaded = Repositories.update(
      retry.model,
      Repositories.Message.GotConsent({
        repositoryId: "701",
        requestId: Option.getOrThrow(retry.model.maybeConsentRequest),
        consent,
      }),
    ).model
    const pending = Repositories.update(loaded, Repositories.Message.ClickedToggleConsent()).model
    const other = Repositories.update(
      pending,
      Repositories.Message.Selected({ repositoryId: "702" }),
    ).model
    const otherConsent = { ...consent, repositoryId: "702" }
    const received = Repositories.update(
      other,
      Repositories.Message.GotConsent({
        repositoryId: "702",
        requestId: Option.getOrThrow(other.maybeConsentRequest),
        consent: otherConsent,
      }),
    ).model
    const second = Repositories.update(received, Repositories.Message.ClickedToggleConsent())
    expect(second.commands?.[0]?.args).toMatchObject({ repositoryId: "702", operationId: 2 })
    const firstDone = Repositories.update(
      second.model,
      Repositories.Message.CompletedSetConsent({
        repositoryId: "701",
        operationId: 1,
        consent: { ...consent, state: "enabled" },
      }),
    )
    expect(firstDone.model.maybeConsent).toEqual(Option.some(otherConsent))
    expect(firstDone.model.pendingMutations).toHaveLength(1)
    expect(firstDone.model.pendingMutations[0]?.repositoryId).toBe("702")
  })

  it("publishes saved policy data to the list even when publication fails", () => {
    const editing = Repositories.update(ready(), Repositories.Message.ClickedNewPolicy()).model
    const persisted: Repositories.PolicyDetail = {
      policy: {
        ...configuration.policies[0]!,
        policyId: "new",
        name: "New policy",
        publishedVersionId: null,
        publishedRevision: null,
      },
      draft: {
        target: "pull_request",
        matchesWhen: { fact: "baseRef", operator: "equals", value: "main" },
      },
      draftDiffers: true,
      published: null,
    }
    const saved = Repositories.update(
      editing,
      Repositories.Message.GotPolicyEditorMessage({
        message: PolicyEditor.Message.SavedDraftWithPublishError({
          detail: persisted,
          reason: "Reference missing",
        }),
      }),
    )
    expect(
      Option.getOrThrow(saved.model.detail).configuration.policies.some(
        (policy) => policy.policyId === "new",
      ),
    ).toBe(true)
    expect(Option.getOrThrow(saved.model.repositories)[0]?.policyCount).toBe(2)
    expect(saved.model.panel._tag).toBe("PolicyEditor")
  })
})

describe("mutation HTTP results", () => {
  it.each([409, 422])("preserves useful delete errors for HTTP %s", async (status) => {
    const body =
      status === 409
        ? Schema.encodeSync(Schema.toCodecJson(RuleRecord))(configuration.rules[0]!)
        : { message: "Retained configuration history uses this policy" }
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status })),
      ),
    )
    const message = await Effect.runPromise(
      Repositories.DeleteSubject({
        repositoryId: "701",
        operationId: 1,
        subjectId: "r1",
        what: "rule",
        version: 1,
        url: "/api/v1/repositories/701/rules/r1",
      }).effect.pipe(Effect.provideService(HttpClient.HttpClient, client)),
    )
    expect(message).toMatchObject({
      _tag: "FailedDelete",
      repositoryId: "701",
      subjectId: "r1",
      operationId: 1,
      reason:
        status === 409
          ? "This item changed meanwhile. Review the refreshed version and retry."
          : "Retained configuration history uses this policy",
    })
  })

  it("decodes the version returned by a rule toggle", async () => {
    const returned = { ...configuration.rules[0]!, enabled: false, version: 2 }
    const encoded = Schema.encodeSync(Schema.toCodecJson(RuleRecord))(returned)
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(JSON.stringify(encoded), { status: 200 })),
      ),
    )
    const message = await Effect.runPromise(
      Repositories.ToggleRule({
        repositoryId: "701",
        operationId: 4,
        ruleId: "r1",
        version: 1,
        enabled: false,
      }).effect.pipe(Effect.provideService(HttpClient.HttpClient, client)),
    )
    expect(message).toMatchObject({
      _tag: "CompletedToggleRule",
      operationId: 4,
      repositoryId: "701",
      rule: { version: 2, enabled: false },
    })
  })
})

describe("shared mutation views", () => {
  it("renders the pending rule state and disables duplicate actions", () => {
    const pending = Repositories.update(
      ready(),
      Repositories.Message.ClickedToggleRule({ ruleId: "r1" }),
    ).model
    Scene.scene(
      { update: Repositories.update, view: Repositories.view },
      Scene.given({ ...pending, section: "Rules" }),
      Scene.expect(Scene.role("switch")).toBeDisabled(),
      Scene.expect(Scene.text("Disabling…")).toExist(),
      Scene.expect(Scene.role("button", { name: "Edit" })).toBeDisabled(),
      Scene.expect(Scene.role("button", { name: "Delete" })).toBeDisabled(),
    )
  })

  it("renders policy deletion without removing its row before confirmation", () => {
    const confirming = Repositories.update(
      ready(),
      Repositories.Message.ClickedDeletePolicy({ policyId: "p1", version: 2 }),
    ).model
    const pending = Repositories.update(
      confirming,
      Repositories.Message.ClickedDeletePolicy({ policyId: "p1", version: 2 }),
    ).model
    Scene.scene(
      { update: Repositories.update, view: Repositories.view },
      Scene.given(pending),
      Scene.expect(Scene.text("Base is main")).toExist(),
      Scene.expect(Scene.text("Deleting…")).toExist(),
    )
  })

  it("updates the saved rule row while retaining newer input in its editor", () => {
    let model = Repositories.update(
      ready(),
      Repositories.Message.ClickedEditRule({ ruleId: "r1" }),
    ).model
    const send = (message: RuleEditor.Message) => {
      model = Repositories.update(
        model,
        Repositories.Message.GotRuleEditorMessage({ message }),
      ).model
    }
    send(RuleEditor.Message.UpdatedGroup({ value: "submitted" }))
    send(RuleEditor.Message.ClickedSave())
    send(RuleEditor.Message.UpdatedGroup({ value: "newer input" }))
    send(
      RuleEditor.Message.SucceededSaveRule({
        operationId: 1,
        rule: { ...configuration.rules[0]!, group: "submitted", version: 2 },
      }),
    )
    expect(Option.getOrThrow(model.detail).configuration.rules[0]).toMatchObject({
      group: "submitted",
      version: 2,
    })
    expect(model.panel._tag).toBe("RuleEditor")
    if (model.panel._tag === "RuleEditor") expect(model.panel.editor.group).toBe("newer input")
    expect(Repositories.hasUnsavedChanges(model)).toBe(true)
    expect(Repositories.isSaving(model)).toBe(false)
  })
})
