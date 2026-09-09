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
import * as Workspace from "@/components/workspace"
import * as Dialog from "@foldkit/ui/dialog"
import * as PolicyEditor from "@/components/policy-editor"
import * as PolicySource from "@/components/policy-source"

const at = DateTime.makeUnsafe("2026-09-03T14:00:00.000Z")
const one: Workspace.RepositoryOverview = {
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
const two: Workspace.RepositoryOverview = { ...one, repositoryId: "702", repo: "two" }

const configuration: Workspace.ConfigurationView = {
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
      onMatch: "ensure-present",
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

const detail: Workspace.RepositoryDetail = {
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

const consent: Workspace.AiConsent = {
  repositoryId: "701",
  state: "disabled",
  provider: "openai",
  model: "gpt-5.6-luna",
  activeLeases: 0,
  updatedAt: at,
}

const opened = (): Workspace.Model => ({
  ...Workspace.init().model,
  dataRepositoryId: Option.some("701"),
  repositories: Option.some([one, two]),
  maybeDetailRequest: Option.some(1),
  detail: Option.some(detail),
})

describe("Repositories", () => {
  it("keeps the unsaved policy visible until the shell accepts cancellation", () => {
    const editing = Workspace.update(opened(), Workspace.Message.ClickedNewPolicy()).model
    Scene.scene(
      {
        update: Workspace.update,
        view: Scene.withViewInputs(Workspace.view, { section: "Policies" })(),
      },
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
      Scene.expectOutMessage(Workspace.OutMessage.RequestedEditorClose({ section: "Policies" })),
      Scene.expect(Scene.text("Unsaved")).toExist(),
    )
  })
  it("offers policy deletion in the right sidebar with confirmation", () => {
    const loading = Workspace.update(
      opened(),
      Workspace.Message.ClickedEditPolicy({ policyId: "p1" }),
    ).model
    const editing = Workspace.update(
      loading,
      Workspace.Message.GotPolicyDetail({
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
      {
        update: Workspace.update,
        view: Scene.withViewInputs(Workspace.view, { section: "Policies" })(),
      },
      Scene.given(editing),
      Scene.Mount.resolve(
        PolicySource.MountPolicySourceEditor,
        PolicySource.Message.MountedEditor(),
      ),
      Scene.inside(
        Scene.role("complementary", { name: "Policy library" }),
        Scene.expect(Scene.role("button", { name: "Delete" })).toBeAbsent(),
      ),
      Scene.expect(Scene.role("button", { name: "Close editor" })).toBeAbsent(),
      Scene.inside(
        Scene.role("complementary", { name: "Policy test bench and information" }),
        Scene.click(Scene.role("button", { name: "Delete policy" })),
      ),
      Scene.Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
      Scene.inside(
        Scene.role("dialog", { name: "Delete policy?" }),
        Scene.expect(Scene.role("button", { name: "Delete policy" })).toExist(),
        Scene.click(Scene.role("button", { name: "Cancel" })),
      ),
      Scene.Command.resolve(Dialog.CloseDialog, Dialog.Message.CompletedCloseDialog()),
      Scene.expect(Scene.role("dialog", { name: "Delete policy?" })).toBeAbsent(),
    )
  })

  it("preserves an open draft while refreshing policy metadata", () => {
    const created = Workspace.update(opened(), Workspace.Message.ClickedNewPolicy()).model
    const edited = Workspace.update(
      created,
      Workspace.Message.GotPolicyEditorMessage({
        message: PolicyEditor.Message.UpdatedName({ value: "Work in progress" }),
      }),
    ).model
    const refreshed = Workspace.update(
      edited,
      Workspace.Message.GotDetail({ requestId: 1, repositoryId: "701", detail }),
    ).model
    expect(refreshed.panel._tag).toBe("PolicyEditor")
    if (refreshed.panel._tag === "PolicyEditor")
      expect(refreshed.panel.editor.name).toBe("Work in progress")
    expect(Workspace.update(refreshed, Workspace.Message.ClickedNewPolicy()).model).toBe(refreshed)
  })

  it("renders a searchable policy library instead of the stacked dashboard", () => {
    Scene.scene(
      {
        update: Workspace.update,
        view: Scene.withViewInputs(Workspace.view, { section: "Policies" })(),
      },
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

  it("fetches the list and catalog, then loads the repository selected by navigation", () => {
    const { model, commands } = Workspace.init()
    expect(commands?.map((command) => command.name)).toEqual(["FetchRepositories", "FetchCatalog"])
    Story.story(
      Workspace.update,
      Story.given(model),
      Story.message(Workspace.Message.GotRepositories({ requestId: 0, repositories: [one, two] })),
      Story.model((next) => expect(next.dataRepositoryId).toEqual(Option.none())),
      Story.message(Workspace.Message.Selected({ repositoryId: "701" })),
      Story.model((next) => expect(next.dataRepositoryId).toEqual(Option.some("701"))),
      Story.Command.resolve(
        Workspace.FetchDetail({ requestId: 1, repositoryId: "701" }),
        Workspace.Message.GotDetail({ requestId: 1, repositoryId: "701", detail }),
      ),
      Story.Command.resolve(
        Workspace.FetchConsent({ requestId: 2, repositoryId: "701" }),
        Workspace.Message.GotConsent({ requestId: 2, repositoryId: "701", consent }),
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
      Workspace.update,
      Story.given({ ...opened(), panel: { _tag: "LoadingPolicy", policyId: "p1" } }),
      Story.message(Workspace.Message.Selected({ repositoryId: "702" })),
      Story.model((next) => {
        expect(next.dataRepositoryId).toEqual(Option.some("702"))
        expect(next.detail).toEqual(Option.none())
        expect(next.panel._tag).toBe("Closed")
      }),
      Story.Command.resolve(
        Workspace.FetchDetail({ requestId: 1, repositoryId: "702" }),
        Workspace.Message.GotDetail({ requestId: 1, repositoryId: "701", detail }),
      ),
      Story.Command.resolve(
        Workspace.FetchConsent({ requestId: 2, repositoryId: "702" }),
        Workspace.Message.GotConsent({ requestId: 2, repositoryId: "701", consent }),
      ),
      Story.model((next) => {
        expect(next.detail).toEqual(Option.none())
        expect(next.maybeConsent).toEqual(Option.none())
      }),
    )
  })

  it("opens editors and the bench from the tables", () => {
    Story.story(
      Workspace.update,
      Story.given(opened()),
      Story.message(Workspace.Message.ClickedNewRule()),
      Story.model((next) => expect(next.panel._tag).toBe("RuleEditor")),
      Story.message(Workspace.Message.ClickedNewPolicy()),
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

  it("deletes a confirmed rule and refreshes afterwards", () => {
    Story.story(
      Workspace.update,
      Story.given(opened()),
      Story.message(Workspace.Message.ClickedDeleteRule({ ruleId: "r1", version: 1 })),
      Story.Command.resolve(
        Workspace.DeleteSubject({
          repositoryId: "701",
          subjectId: "r1",
          operationId: 1,
          url: "/api/v1/repositories/701/rules/r1",
          version: 1,
          what: "rule",
        }),
        Workspace.Message.CompletedDelete({
          what: "rule",
          repositoryId: "701",
          subjectId: "r1",
          operationId: 1,
        }),
      ),
      Story.expectOutMessage(
        Workspace.OutMessage.Notified({
          title: "Deleted the rule",
          description: "The list has been updated.",
        }),
      ),
      Story.Command.resolve(
        Workspace.FetchDetail({ requestId: 1, repositoryId: "701" }),
        Workspace.Message.GotDetail({ requestId: 1, repositoryId: "701", detail }),
      ),
      Story.Command.resolve(
        Workspace.FetchConsent({ requestId: 2, repositoryId: "701" }),
        Workspace.Message.GotConsent({ requestId: 2, repositoryId: "701", consent }),
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

const ready = (): Workspace.Model => {
  const listed = Workspace.update(
    Workspace.init().model,
    Workspace.Message.GotRepositories({ requestId: 0, repositories: [one, two] }),
  ).model
  const selected = Workspace.update(
    listed,
    Workspace.Message.Selected({ repositoryId: "701" }),
  ).model
  return Workspace.update(
    selected,
    Workspace.Message.GotDetail({ repositoryId: "701", requestId: 1, detail }),
  ).model
}

describe("mutation reconciliation", () => {
  it("toggles a rule immediately, serializes its writes, and rolls back only that field", () => {
    const clicked = Workspace.update(ready(), Workspace.Message.ClickedToggleRule({ ruleId: "r1" }))
    expect(Option.getOrThrow(clicked.model.detail).configuration.rules[0]?.enabled).toBe(false)
    expect(
      Workspace.update(clicked.model, Workspace.Message.ClickedToggleRule({ ruleId: "r1" }))
        .commands,
    ).toBeUndefined()
    expect(
      Workspace.update(
        clicked.model,
        Workspace.Message.ClickedDeleteRule({ ruleId: "r1", version: 1 }),
      ).commands,
    ).toBeUndefined()
    const changed = { ...clicked.model, policySearch: "keep this" }
    const failed = Workspace.update(
      changed,
      Workspace.Message.FailedToggleRule({
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
    const poll = Workspace.update(ready(), Workspace.Message.Polled())
    const oldRequest = Option.getOrThrow(poll.model.maybeDetailRequest)
    const clicked = Workspace.update(
      poll.model,
      Workspace.Message.ClickedToggleRule({ ruleId: "r1" }),
    )
    const polled = Workspace.update(
      clicked.model,
      Workspace.Message.GotDetail({ repositoryId: "701", requestId: oldRequest, detail }),
    )
    expect(Option.getOrThrow(polled.model.detail).configuration.rules[0]?.enabled).toBe(false)
    const rule = { ...configuration.rules[0]!, enabled: false, version: 2 }
    const saved = Workspace.update(
      polled.model,
      Workspace.Message.CompletedToggleRule({ repositoryId: "701", operationId: 1, rule }),
    )
    expect(Option.getOrThrow(saved.model.detail).configuration.rules[0]).toEqual(rule)
    expect(saved.outMessage?._tag).toBe("SyncWorkChanged")
    const obsolete = Workspace.update(
      saved.model,
      Workspace.Message.GotDetail({ repositoryId: "701", requestId: oldRequest, detail }),
    )
    expect(obsolete.model).toBe(saved.model)
    expect(
      Workspace.update(saved.model, Workspace.Message.Polled()).commands?.filter(
        (command) => command.name === "FetchDetail",
      ),
    ).toHaveLength(0)
  })

  it("removes a deleted policy immediately without closing another policy", () => {
    const first = Workspace.update(
      ready(),
      Workspace.Message.ClickedDeletePolicy({ policyId: "p1", version: 2 }),
    ).model
    const deleting = Workspace.update(
      first,
      Workspace.Message.ClickedDeletePolicy({ policyId: "p1", version: 2 }),
    ).model
    expect(deleting.pendingMutations[0]?.kind).toBe("PolicyDelete")
    const openedOther = Workspace.update(deleting, Workspace.Message.ClickedNewPolicy()).model
    const completed = Workspace.update(
      openedOther,
      Workspace.Message.CompletedDelete({
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
      Workspace.update(
        completed.model,
        Workspace.Message.CompletedDelete({
          repositoryId: "701",
          subjectId: "p1",
          what: "policy",
          operationId: 1,
        }),
      ).model,
    ).toBe(completed.model)
  })

  it("keeps a rejected deletion visible and reports the server reason", () => {
    const first = Workspace.update(
      ready(),
      Workspace.Message.ClickedDeletePolicy({ policyId: "p1", version: 2 }),
    ).model
    const deleting = Workspace.update(
      first,
      Workspace.Message.ClickedDeletePolicy({ policyId: "p1", version: 2 }),
    ).model
    const failed = Workspace.update(
      deleting,
      Workspace.Message.FailedDelete({
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
    const failed = Workspace.update(
      ready(),
      Workspace.Message.FailedConsent({ repositoryId: "701", requestId: 2, reason: "Offline" }),
    )
    expect(failed.model.consentError).toEqual(Option.some("Offline"))
    const retry = Workspace.update(failed.model, Workspace.Message.ClickedRetryConsent())
    const loaded = Workspace.update(
      retry.model,
      Workspace.Message.GotConsent({
        repositoryId: "701",
        requestId: Option.getOrThrow(retry.model.maybeConsentRequest),
        consent,
      }),
    ).model
    const pending = Workspace.update(loaded, Workspace.Message.ClickedToggleConsent()).model
    const other = Workspace.update(
      pending,
      Workspace.Message.Selected({ repositoryId: "702" }),
    ).model
    const otherConsent = { ...consent, repositoryId: "702" }
    const received = Workspace.update(
      other,
      Workspace.Message.GotConsent({
        repositoryId: "702",
        requestId: Option.getOrThrow(other.maybeConsentRequest),
        consent: otherConsent,
      }),
    ).model
    const second = Workspace.update(received, Workspace.Message.ClickedToggleConsent())
    expect(second.commands?.[0]?.args).toMatchObject({ repositoryId: "702", operationId: 2 })
    const firstDone = Workspace.update(
      second.model,
      Workspace.Message.CompletedSetConsent({
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
    const editing = Workspace.update(ready(), Workspace.Message.ClickedNewPolicy()).model
    const persisted: Workspace.PolicyDetail = {
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
    const saved = Workspace.update(
      editing,
      Workspace.Message.GotPolicyEditorMessage({
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
      Workspace.DeleteSubject({
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
      Workspace.ToggleRule({
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
    const pending = Workspace.update(
      ready(),
      Workspace.Message.ClickedToggleRule({ ruleId: "r1" }),
    ).model
    Scene.scene(
      {
        update: Workspace.update,
        view: Scene.withViewInputs(Workspace.view, { section: "Rules" })(),
      },
      Scene.given(pending),
      Scene.expect(Scene.text("Disabling…")).toExist(),
      Scene.expect(Scene.role("switch", { name: "Enable bug" })).toBeDisabled(),
      Scene.expect(Scene.role("button", { name: "Actions for bug" })).toBeDisabled(),
    )
  })

  it("renders policy deletion without removing its row before confirmation", () => {
    const confirming = Workspace.update(
      ready(),
      Workspace.Message.ClickedDeletePolicy({ policyId: "p1", version: 2 }),
    ).model
    const pending = Workspace.update(
      confirming,
      Workspace.Message.ClickedDeletePolicy({ policyId: "p1", version: 2 }),
    ).model
    Scene.scene(
      {
        update: Workspace.update,
        view: Scene.withViewInputs(Workspace.view, { section: "Policies" })(),
      },
      Scene.given(pending),
      Scene.expect(Scene.text("Base is main")).toExist(),
      Scene.expect(Scene.text("Deleting…")).toExist(),
    )
  })

  it("updates the saved rule row while retaining newer input in its editor", () => {
    let model = Workspace.update(ready(), Workspace.Message.ClickedEditRule({ ruleId: "r1" })).model
    const send = (message: RuleEditor.Message) => {
      model = Workspace.update(model, Workspace.Message.GotRuleEditorMessage({ message })).model
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
    expect(Workspace.hasUnsavedChanges(model)).toBe(true)
    expect(Workspace.isSaving(model)).toBe(false)
  })
})

describe("rules workspace", () => {
  it("requests navigation back without closing the rule editor before confirmation", () => {
    const table = ready()
    const opened = Workspace.update(
      table,
      Workspace.Message.ClickedEditRule({ ruleId: "r1" }),
    ).model
    Scene.scene(
      {
        update: Workspace.update,
        view: Scene.withViewInputs(Workspace.view, { section: "Rules" })(),
      },
      Scene.given(opened),
      Scene.expect(Scene.role("button", { name: "Back to rules" })).toExist(),
      Scene.expect(Scene.role("table")).not.toExist(),
      Scene.click(Scene.role("button", { name: "Back to rules" })),
      Scene.expectOutMessage(Workspace.OutMessage.RequestedEditorClose({ section: "Rules" })),
      Scene.expect(Scene.role("table")).not.toExist(),
    )
  })
})

describe("GitHub label badge colors", () => {
  it("uses the GitHub color with readable foregrounds and rejects invalid CSS", () => {
    expect(Workspace.labelBadgeStyle("ffffff")).toMatchObject({
      backgroundColor: "#ffffff",
      color: "#111111",
    })
    expect(Workspace.labelBadgeStyle("000000")).toMatchObject({
      backgroundColor: "#000000",
      color: "#ffffff",
    })
    expect(Workspace.labelBadgeStyle("d73a4a").backgroundColor).toBe("#d73a4a")
    expect(Workspace.labelBadgeStyle("red;display:none")).toEqual({})
    expect(Workspace.labelBadgeStyle(null)).toEqual({})
  })
})

it("renders the minimal repository Overview with a rules link", () => {
  Scene.scene(
    {
      update: Workspace.update,
      view: Scene.withViewInputs(Workspace.view, { section: "Overview" })(),
    },
    Scene.given(opened()),
    Scene.expect(Scene.text("Your repository is connected.")).toExist(),
    Scene.expect(Scene.role("link", { name: "View rules" })).toExist(),
    Scene.expect(Scene.text("Recent activity")).toBeAbsent(),
  )
})

it.each(["pending", "failed"] as const)(
  "renders Overview while unrelated repository details are %s",
  (state) => {
    Scene.scene(
      {
        update: Workspace.update,
        view: Scene.withViewInputs(Workspace.view, { section: "Overview" })(),
      },
      Scene.given({
        ...opened(),
        detail: Option.none(),
        detailError: state === "failed" ? Option.some("Detail request failed") : Option.none(),
      }),
      Scene.expect(Scene.text("Your repository is connected.")).toExist(),
      Scene.expect(Scene.role("link", { name: "View rules" })).toExist(),
      Scene.expect(Scene.text("Loading repository…")).toBeAbsent(),
      Scene.expect(Scene.text("Detail request failed")).toBeAbsent(),
    )
  },
)

it("shows the newly selected repository before its details load", () => {
  Scene.scene(
    {
      update: Workspace.update,
      view: Scene.withViewInputs(Workspace.view, { section: "Overview" })(),
    },
    Scene.given({ ...opened(), dataRepositoryId: Option.some("702"), detail: Option.none() }),
    Scene.expect(Scene.text("effect / two")).toExist(),
    Scene.expect(Scene.text("effect / one")).toBeAbsent(),
  )
})

it.each(["pending", "failed"] as const)(
  "shows repository list state when the repository itself is %s",
  (state) => {
    Scene.scene(
      {
        update: Workspace.update,
        view: Scene.withViewInputs(Workspace.view, { section: "Overview" })(),
      },
      Scene.given({
        ...opened(),
        repositories: Option.none(),
        repositoriesError:
          state === "failed" ? Option.some("Repository list failed") : Option.none(),
      }),
      Scene.expect(
        Scene.text(state === "failed" ? "Repository list failed" : "Loading repository…"),
      ).toExist(),
      Scene.expect(Scene.role("link", { name: "View rules" })).toBeAbsent(),
    )
  },
)
