import * as DateTime from "effect/DateTime"
import * as Option from "effect/Option"
import { Scene, Story } from "foldkit/test"
import { describe, expect, it } from "vite-plus/test"
import type { PolicyRecord, RuleRecord } from "@/components/labeling-wire"
import * as RuleEditor from "@/components/rule-editor"

const at = DateTime.makeUnsafe("2026-09-03T14:00:00.000Z")
const published: PolicyRecord = {
  policyId: "p1",
  repositoryId: "701",
  name: "Base is main",
  target: "pull_request",
  description: "",
  publishedVersionId: "v1",
  publishedRevision: 1,
  version: 2,
  createdAt: at,
  updatedAt: at,
}
const draft: PolicyRecord = {
  ...published,
  policyId: "p2",
  name: "Draft",
  publishedVersionId: null,
  publishedRevision: null,
}
const labels = [{ labelId: "11", name: "bug", availability: "available" as const }]
const rule: RuleRecord = {
  id: "r1",
  repositoryId: "701",
  labelId: "11",
  policyId: "p1",
  onMatch: "ensure-present",
  onNoMatch: "no-action",
  group: "size",
  priority: 3,
  enabled: true,
  labelStatus: "valid",
  version: 1,
  createdAt: at,
  updatedAt: at,
}

describe("RuleEditor", () => {
  it("validates group membership and reserved priorities in the editor", () => {
    const other = { ...rule, id: "r2", labelId: "12", priority: 7, enabled: false }
    const model = RuleEditor.init({
      repositoryId: "701",
      labels,
      policies: [published],
      rules: [rule, other],
      existing: Option.some(rule),
    })
    const collision = RuleEditor.update(
      model,
      RuleEditor.Message.UpdatedPriority({ value: "7" }),
    ).model
    expect(RuleEditor.draftIssues(collision)).toContain(
      "Priority 7 is reserved by another group member, including disabled rules. Use reordering to swap priorities.",
    )
    const aiModel = RuleEditor.init({
      repositoryId: "701",
      labels,
      policies: [published],
      rules: [other],
      existing: Option.some({
        ...rule,
        ai: { target: "issue", prompt: "Review {{fact:title}}", minimumConfidence: 0.8 },
      }),
    })
    expect(RuleEditor.draftIssues(aiModel)).toContain(
      "This labeling group targets pull_request. Choose another group for this target.",
    )
    Scene.scene(
      { update: RuleEditor.update, view: Scene.withViewInputs(RuleEditor.view, {})() },
      Scene.given(model),
      Scene.expect(Scene.text("Move up")).toExist(),
    )
  })
  it("accepts the reordered priority while preserving unrelated edits made during the request", () => {
    const other = { ...rule, id: "r2", labelId: "12", priority: 7, enabled: false }
    const model = RuleEditor.init({
      repositoryId: "701",
      labels,
      policies: [published],
      rules: [rule, other],
      existing: Option.some(rule),
    })
    const pending = RuleEditor.update(
      model,
      RuleEditor.Message.MovedGroupRule({ ruleId: "r1", direction: "up" }),
    ).model
    const edited = RuleEditor.update(
      pending,
      RuleEditor.Message.ToggledEnabled({ isChecked: false }),
    ).model
    const result = RuleEditor.update(
      edited,
      RuleEditor.Message.SucceededReorderGroup({
        operationId: 1,
        rules: [
          { ...other, priority: 3, version: 2 },
          { ...rule, priority: 7, version: 2 },
        ],
      }),
    )
    expect(result.model.priority).toBe("7")
    expect(result.model.enabled).toBe(false)
    expect(RuleEditor.draftIssues(result.model)).toEqual([])
    expect(RuleEditor.hasUnsavedChanges(result.model)).toBe(true)
    const saving = RuleEditor.update(result.model, RuleEditor.Message.ClickedSave())
    expect(saving.model.submission._tag).toBe("Submitting")
    const priorityEdit = RuleEditor.update(
      pending,
      RuleEditor.Message.UpdatedPriority({ value: "9" }),
    ).model
    const preserved = RuleEditor.update(
      priorityEdit,
      RuleEditor.Message.SucceededReorderGroup({
        operationId: 1,
        rules: [
          { ...other, priority: 3, version: 2 },
          { ...rule, priority: 7, version: 2 },
        ],
      }),
    )
    expect(preserved.model.priority).toBe("9")
  })
  it("reorders a group including disabled members with one versioned request", () => {
    const other = { ...rule, id: "r2", labelId: "12", priority: 7, enabled: false }
    const model = RuleEditor.init({
      repositoryId: "701",
      labels,
      policies: [published],
      rules: [rule, other],
      existing: Option.some(rule),
    })
    Story.story(
      RuleEditor.update,
      Story.given(model),
      Story.message(RuleEditor.Message.MovedGroupRule({ ruleId: "r1", direction: "up" })),
      Story.Command.resolve(
        RuleEditor.ReorderGroup({
          repositoryId: "701",
          group: "size",
          operationId: 1,
          rules: [
            { id: "r2", version: 1, priority: 3 },
            { id: "r1", version: 1, priority: 7 },
          ],
        }),
        RuleEditor.Message.SucceededReorderGroup({
          operationId: 1,
          rules: [
            { ...other, priority: 3, version: 2 },
            { ...rule, priority: 7, version: 2 },
          ],
        }),
      ),
      Story.model((next) => {
        expect(next.priority).toBe("7")
        expect(next.identity).toEqual({ _tag: "Existing", ruleId: "r1", version: 2 })
        expect(RuleEditor.hasUnsavedChanges(next)).toBe(false)
      }),
      Story.expectOutMessage(
        RuleEditor.OutMessage.Saved({
          rule: { ...rule, priority: 7, version: 2 },
          closeEditor: false,
        }),
      ),
    )
  })

  it("identifies the label owner after a rejected save and retains the draft", () => {
    const model = RuleEditor.init({
      repositoryId: "701",
      labels,
      policies: [published],
      existing: Option.some(rule),
    })
    const saving = RuleEditor.update(model, RuleEditor.Message.ClickedSave()).model
    const message =
      "Label 11 is already owned for pull requests by disabled rule r2. Edit or delete that rule, or choose another label. Disabling a rule retains ownership."
    const rejected = RuleEditor.update(
      saving,
      RuleEditor.Message.RejectedSaveRule({
        operationId: 1,
        issues: [{ code: "duplicate-label", message }],
      }),
    )
    expect(rejected.model.maybeLabelId).toEqual(Option.some("11"))
    expect(rejected.outMessage).toBeUndefined()
    Scene.scene(
      { update: RuleEditor.update, view: Scene.withViewInputs(RuleEditor.view, {})() },
      Scene.given(rejected.model),
      Scene.expect(Scene.text(message)).toExist(),
    )
  })
  it("needs a label and a published policy, then saves the binding", () => {
    const model = RuleEditor.init({
      repositoryId: "701",
      labels,
      policies: [published, draft],
      existing: Option.none(),
    })
    expect(RuleEditor.draftIssues(model)).toEqual(["Pick a label", "Pick a published policy"])
    Story.story(
      RuleEditor.update,
      Story.given(model),
      Story.message(RuleEditor.Message.SelectedLabel({ labelId: "11" })),
      Story.message(RuleEditor.Message.UpdatedPolicy({ value: "p1" })),
      Story.message(RuleEditor.Message.UpdatedGroup({ value: "size" })),
      Story.message(RuleEditor.Message.UpdatedPriority({ value: "abc" })),
      Story.model((next) =>
        expect(RuleEditor.draftIssues(next)).toEqual(["Priority must be a whole number"]),
      ),
      Story.message(RuleEditor.Message.UpdatedPriority({ value: "3" })),
      Story.message(RuleEditor.Message.ClickedSave()),
      Story.Command.resolve(
        RuleEditor.SaveRule({
          operationId: 1,
          repositoryId: "701",
          identity: { _tag: "New" },
          labelId: "11",
          policyId: "p1",
          onMatch: "ensure-present",
          onNoMatch: "ensure-absent",
          group: "size",
          priority: 3,
          enabled: true,
        }),
        RuleEditor.Message.SucceededSaveRule({ rule, operationId: 1 }),
      ),
      Story.expectOutMessage(RuleEditor.OutMessage.Saved({ rule, closeEditor: true })),
    )
  })

  it("loads an existing rule and surfaces server issues", () => {
    const model = RuleEditor.init({
      repositoryId: "701",
      labels,
      policies: [published],
      existing: Option.some(rule),
    })
    expect(model.identity).toEqual({ _tag: "Existing", ruleId: "r1", version: 1 })
    expect(model.group).toBe("size")
    expect(model.priority).toBe("3")
    Story.story(
      RuleEditor.update,
      Story.given(model),
      Story.message(RuleEditor.Message.ClickedSave()),
      Story.Command.resolve(
        RuleEditor.SaveRule,
        RuleEditor.Message.RejectedSaveRule({
          operationId: 1,
          issues: [{ code: "unavailable-label", message: "Label bug was deleted on GitHub" }],
        }),
      ),
      Story.model((next) => expect(next.submission._tag).toBe("Rejected")),
      Story.expectNoOutMessage(),
    )
  })
})

describe("rule save lifetime", () => {
  const existing = () =>
    RuleEditor.init({
      repositoryId: "701",
      labels,
      policies: [published],
      existing: Option.some(rule),
    })

  it("keeps a pending write while editing and preserves the newer draft after success", () => {
    const saving = RuleEditor.update(existing(), RuleEditor.Message.ClickedSave()).model
    const edited = RuleEditor.update(
      saving,
      RuleEditor.Message.UpdatedGroup({ value: "later edit" }),
    ).model
    expect(edited.submission._tag).toBe("Submitting")
    expect(RuleEditor.update(edited, RuleEditor.Message.ClickedSave()).commands).toBeUndefined()
    expect(RuleEditor.update(edited, RuleEditor.Message.ClickedCancel()).outMessage).toBeUndefined()
    const saved = RuleEditor.update(
      edited,
      RuleEditor.Message.SucceededSaveRule({ rule: { ...rule, version: 2 }, operationId: 1 }),
    )
    expect(saved.model.group).toBe("later edit")
    expect(saved.model.identity).toEqual({ _tag: "Existing", ruleId: "r1", version: 2 })
    expect(saved.outMessage).toEqual(
      RuleEditor.OutMessage.Saved({ rule: { ...rule, version: 2 }, closeEditor: false }),
    )
    expect(RuleEditor.hasUnsavedChanges(saved.model)).toBe(true)
    const retry = RuleEditor.update(saved.model, RuleEditor.Message.ClickedSave())
    expect(retry.commands?.[0]?.args).toMatchObject({
      operationId: 2,
      identity: { version: 2 },
      group: "later edit",
    })
    expect(
      RuleEditor.update(
        retry.model,
        RuleEditor.Message.FailedSaveRule({ operationId: 1, reason: "obsolete" }),
      ).model,
    ).toBe(retry.model)
  })

  it("updates the saved identity of a new rule before another edit can be saved", () => {
    let model = RuleEditor.init({
      repositoryId: "701",
      labels,
      policies: [published],
      existing: Option.none(),
    })
    model = RuleEditor.update(model, RuleEditor.Message.SelectedLabel({ labelId: "11" })).model
    model = RuleEditor.update(model, RuleEditor.Message.UpdatedPolicy({ value: "p1" })).model
    model = RuleEditor.update(model, RuleEditor.Message.ClickedSave()).model
    model = RuleEditor.update(model, RuleEditor.Message.UpdatedPriority({ value: "7" })).model
    const saved = RuleEditor.update(
      model,
      RuleEditor.Message.SucceededSaveRule({ operationId: 1, rule }),
    )
    expect(saved.outMessage?._tag).toBe("Saved")
    expect(
      RuleEditor.update(saved.model, RuleEditor.Message.ClickedSave()).commands?.[0]?.args,
    ).toMatchObject({ identity: { _tag: "Existing", ruleId: "r1" }, operationId: 2 })
  })
})

describe("rule flow testing", () => {
  const fresh = () =>
    RuleEditor.init({
      repositoryId: "701",
      labels,
      policies: [published, draft],
      existing: Option.some(rule),
      testCandidates: {
        _tag: "Ready",
        items: [
          {
            number: 12,
            kind: "pull_request",
            title: "Update docs",
            authorLogin: "octocat",
            labels: [],
            baseRef: "main",
            draft: false,
            evaluation: null,
            plan: null,
          },
          {
            number: 13,
            kind: "issue",
            title: "Bug report",
            authorLogin: "octocat",
            labels: [],
            baseRef: null,
            draft: null,
            evaluation: null,
            plan: null,
          },
        ],
      },
    })
  it("shows omissions from the tested snapshot and explains expired inspection", () => {
    const initial = fresh()
    if (initial.testCandidates._tag !== "Ready") return
    const started = RuleEditor.update(initial, RuleEditor.Message.ClickedTest()).model
    const completed = RuleEditor.update(
      started,
      RuleEditor.Message.CompletedTest({
        generation: started.testGeneration,
        testId: "test-1",
        response: {
          _tag: "Evaluated",
          entities: [
            {
              ...initial.testCandidates.items[0]!,
              evaluation: {
                outcome: "match",
                reason: "Matches",
                trace: [],
                inputReport: {
                  version: 3,
                  budgetBytes: 16000,
                  originalBytes: 18000,
                  suppliedBytes: 16000,
                  status: "shortened",
                  facts: [
                    {
                      name: "body",
                      originalBytes: 15,
                      suppliedBytes: 9,
                      omission: { start: 5, end: 11, unit: "characters" },
                    },
                  ],
                },
              },
            },
          ],
        },
      }),
    ).model
    const loading = RuleEditor.update(completed, RuleEditor.Message.ClickedInspectInput())
    expect(loading.commands?.[0]?.name).toBe("LoadRuleTestInput")
    const ready = RuleEditor.update(
      loading.model,
      RuleEditor.Message.LoadedInput({
        generation: started.testGeneration,
        details: {
          system: "system",
          text: "prepared input",
          facts: [{ name: "body", json: JSON.stringify("startMIDDLEend") }],
        },
      }),
    ).model
    const scene = { update: RuleEditor.update, view: Scene.withViewInputs(RuleEditor.view, {})() }
    Scene.scene(
      scene,
      Scene.given(ready),
      Scene.expect(Scene.text("AI input shortened")).toExist(),
      Scene.expect(Scene.text("MIDDLE")).toExist(),
      Scene.expect(Scene.text("View sent input")).toExist(),
    )
    const expired = RuleEditor.update(
      loading.model,
      RuleEditor.Message.FailedInput({
        generation: started.testGeneration,
        reason: "Input details expired. Run the test again.",
      }),
    ).model
    Scene.scene(
      scene,
      Scene.given(expired),
      Scene.expect(Scene.role("alert")).toHaveText("Input details expired. Run the test again."),
    )
  })
  it("keeps progress monotonic and ignores updates after completion", () => {
    const started = RuleEditor.update(fresh(), RuleEditor.Message.ClickedTest()).model
    expect(started.testResult).toMatchObject({ status: "submitting" })
    const progress = (status: "queued" | "running") =>
      RuleEditor.Message.QueuedTest({
        testId: "test-1",
        generation: started.testGeneration,
        status,
        polls: 1,
        startedAt: 0,
        elapsedSeconds: 5,
      })
    const queued = RuleEditor.update(started, progress("queued")).model
    expect(queued.testResult).toMatchObject({ status: "queued" })
    const running = RuleEditor.update(queued, progress("running")).model
    const old = RuleEditor.update(running, progress("queued"))
    expect(old.model.testResult).toMatchObject({ status: "running" })
    expect(old.commands).toEqual([])
    const refreshed = RuleEditor.update(old.model, RuleEditor.Message.RefreshTest())
    expect(refreshed.commands?.[0]?.name).toBe("PollRuleTest")
    const repeated = RuleEditor.update(refreshed.model, RuleEditor.Message.RefreshTest())
    expect(repeated.commands).toBeUndefined()
    expect(repeated.model.jobRefresh).toBe(true)
    const done = RuleEditor.update(
      old.model,
      RuleEditor.Message.CompletedTest({
        generation: started.testGeneration,
        testId: "test-1",
        response: { _tag: "Evaluated", entities: [] },
      }),
    ).model
    expect(RuleEditor.update(done, progress("queued")).model).toBe(done)
    expect(
      RuleEditor.update(
        done,
        RuleEditor.Message.FailedTest({
          generation: started.testGeneration,
          reason: "late failure",
        }),
      ).model,
    ).toBe(done)
  })
  it("polls the same job after a transient read failure and fences stale input inspection", () => {
    const started = RuleEditor.update(fresh(), RuleEditor.Message.ClickedTest()).model
    const next = RuleEditor.update(
      started,
      RuleEditor.Message.QueuedTest({
        testId: "same-job",
        generation: started.testGeneration,
        status: "queued",
        polls: 2,
        startedAt: 0,
        elapsedSeconds: 10,
        pollError: "offline",
      }),
    )
    expect(next.commands?.[0]?.args).toMatchObject({ testId: "same-job" })
    expect(next.commands?.[0]?.name).toBe("PollRuleTest")
    const edited = RuleEditor.update(
      next.model,
      RuleEditor.Message.UpdatedPriority({ value: "1" }),
    ).model
    expect(
      RuleEditor.update(
        edited,
        RuleEditor.Message.LoadedInput({
          generation: started.testGeneration,
          details: { system: "", text: "old", facts: [] },
        }),
      ).model,
    ).toBe(edited)
  })
  it("tests only the selected target and ignores results from before an edit", () => {
    expect(RuleEditor.testItems(fresh()).map((item) => item.number)).toEqual([12])
    const started = RuleEditor.update(fresh(), RuleEditor.Message.ClickedTest()).model
    expect(started.testResult._tag).toBe("Running")
    const edited = RuleEditor.update(
      started,
      RuleEditor.Message.UpdatedOnNoMatch({ value: "ensure-absent" }),
    ).model
    const late = RuleEditor.update(
      edited,
      RuleEditor.Message.CompletedTest({
        generation: started.testGeneration,
        response: { _tag: "Evaluated", entities: [] },
      }),
    ).model
    expect(late.testResult._tag).toBe("Idle")
    expect(late.onNoMatch).toBe("ensure-absent")
  })
  it("requires an available label and a published policy", () => {
    const noLabel = RuleEditor.update(
      fresh(),
      RuleEditor.Message.SelectedLabel({ labelId: "" }),
    ).model
    expect(RuleEditor.draftIssues(noLabel)).toContain("Pick a label")
    const unpublished = RuleEditor.update(
      fresh(),
      RuleEditor.Message.UpdatedPolicy({ value: "p2" }),
    ).model
    expect(
      RuleEditor.update(unpublished, RuleEditor.Message.ClickedTest()).commands,
    ).toBeUndefined()
    expect(RuleEditor.draftIssues(unpublished)).toContain("Pick a published policy")
  })
  it("preserves labels for unknown, inapplicable, and disabled evaluations", () => {
    expect(RuleEditor.previewAction(fresh(), "unknown", ["11"])).toContain("unchanged")
    expect(
      RuleEditor.previewAction({ ...fresh(), onNoMatch: "ensure-absent" }, "failed", ["11"]),
    ).toContain("unchanged")
    expect(RuleEditor.previewAction(fresh(), "not-applicable", ["11"])).toContain("unchanged")
    expect(RuleEditor.previewAction({ ...fresh(), enabled: false }, "match", [])).toContain(
      "disabled",
    )
    expect(
      RuleEditor.previewAction({ ...fresh(), onNoMatch: "ensure-absent" }, "no-match", ["11"]),
    ).toBe("Ensure absent: bug · Remove label")
    expect(RuleEditor.previewAction(fresh(), "match", [])).toBe("Ensure present: bug · Add label")
  })
})

describe("rule flow view", () => {
  const existing = () =>
    RuleEditor.init({
      repositoryId: "701",
      labels,
      policies: [published],
      existing: Option.some(rule),
    })
  const scene = { update: RuleEditor.update, view: Scene.withViewInputs(RuleEditor.view, {})() }
  it("shows Enable and Back navigation, with save controls only after edits", () => {
    Scene.scene(
      scene,
      Scene.given(existing()),
      Scene.expect(Scene.role("switch", { name: "Enable" })).toExist(),
      Scene.expect(Scene.role("button", { name: "Back to rules" })).toExist(),
      Scene.expect(Scene.role("button", { name: "Save changes" })).not.toExist(),
      Scene.click(Scene.role("switch", { name: "Enable" })),
      Scene.expect(Scene.role("button", { name: "Save changes" })).toExist(),
      Scene.expect(Scene.role("button", { name: "Delete rule" })).toExist(),
    )
  })
})

it("saves an AI definition without selecting a policy and tests unsaved facts", () => {
  const catalog = ["title", "body"].map((name) => ({
    name,
    type: "Text" as const,
    kinds: ["issue", "pull_request"] as const,
    track: "entities",
    description: name,
    fields: [],
    operators: [],
  }))
  let model = RuleEditor.init({
    repositoryId: "701",
    labels,
    policies: [],
    existing: Option.none(),
    catalog,
    testCandidates: {
      _tag: "Ready",
      items: [
        {
          number: 5,
          kind: "pull_request",
          title: "Change",
          authorLogin: "a",
          baseRef: "main",
          draft: false,
          labels: [],
          evaluation: null,
          plan: null,
        },
      ],
    },
  })
  model = RuleEditor.update(model, RuleEditor.Message.SelectedType({ value: "ai" })).model
  model = RuleEditor.update(model, RuleEditor.Message.SelectedLabel({ labelId: "11" })).model
  expect(RuleEditor.draftIssues(model)).toEqual([])
  expect(RuleEditor.update(model, RuleEditor.Message.ClickedSave()).commands).toHaveLength(1)
  expect(RuleEditor.update(model, RuleEditor.Message.ClickedTest()).commands).toHaveLength(1)
  model = RuleEditor.update(
    model,
    RuleEditor.Message.EditedPrompt({ value: "{{fact:diff}}" }),
  ).model
  expect(RuleEditor.draftIssues(model)).toContain("Unknown fact 'diff'")
  expect(RuleEditor.update(model, RuleEditor.Message.ClickedSave()).commands).toBeUndefined()
})

it("requires confirmation before deleting a rule and supports cancellation", () => {
  const model = RuleEditor.init({
    repositoryId: "701",
    policies: [published],
    labels,
    existing: Option.some(rule),
  })
  expect(RuleEditor.update(model, RuleEditor.Message.ConfirmedDelete()).outMessage).toBeUndefined()
  const opened = RuleEditor.update(model, RuleEditor.Message.ClickedDelete())
  expect(opened.model.deleteDialog.isOpen).toBe(true)
  expect(opened.outMessage).toBeUndefined()
  const cancelled = RuleEditor.update(opened.model, RuleEditor.Message.CancelledDelete())
  expect(cancelled.model.deleteDialog.isOpen).toBe(false)
  expect(cancelled.outMessage).toBeUndefined()
  const confirmed = RuleEditor.update(opened.model, RuleEditor.Message.ConfirmedDelete())
  expect(confirmed.outMessage).toEqual({ _tag: "RequestedDelete", ruleId: "r1", version: 1 })
  expect(confirmed.model.deleteDialog.isOpen).toBe(false)
})

it("previews both configured AI result actions", () => {
  const model = RuleEditor.init({
    repositoryId: "701",
    labels,
    policies: [],
    existing: Option.some({
      ...rule,
      ai: { target: "pull_request", prompt: "Read {{fact:title}}", minimumConfidence: 0.8 },
      onMatch: "ensure-absent",
      onNoMatch: "ensure-present",
    }),
  })
  expect(RuleEditor.previewAction(model, "match", ["11"])).toBe("Ensure absent: bug · Remove label")
  expect(RuleEditor.previewAction(model, "no-match", [])).toBe("Ensure present: bug · Add label")
})

it("edits either AI result action without resetting it when choosing the rule type", () => {
  let model = RuleEditor.init({
    repositoryId: "701",
    labels,
    policies: [published],
    existing: Option.none(),
    catalog: ["title", "body"].map((name) => ({
      name,
      type: "Text",
      kinds: ["issue", "pull_request"],
      track: "entities",
      description: name,
      fields: [],
      operators: [],
    })),
  })
  model = RuleEditor.update(
    model,
    RuleEditor.Message.UpdatedOnMatch({ value: "ensure-absent" }),
  ).model
  model = RuleEditor.update(
    model,
    RuleEditor.Message.UpdatedOnNoMatch({ value: "ensure-present" }),
  ).model
  model = RuleEditor.update(model, RuleEditor.Message.SelectedType({ value: "ai" })).model
  model = RuleEditor.update(model, RuleEditor.Message.SelectedLabel({ labelId: "11" })).model
  expect(
    RuleEditor.update(model, RuleEditor.Message.ClickedSave()).commands?.[0]?.args,
  ).toMatchObject({
    onMatch: "ensure-absent",
    onNoMatch: "ensure-present",
  })
  model = RuleEditor.update(model, RuleEditor.Message.UpdatedOnMatch({ value: "no-action" })).model
  expect(RuleEditor.previewAction(model, "match", ["11"])).toBe("Take no action")
  model = RuleEditor.update(
    model,
    RuleEditor.Message.UpdatedOnNoMatch({ value: "no-action" }),
  ).model
  expect(RuleEditor.previewAction(model, "no-match", [])).toBe("Take no action")
  Scene.scene(
    { update: RuleEditor.update, view: Scene.withViewInputs(RuleEditor.view, {})() },
    Scene.given(
      RuleEditor.init({
        repositoryId: "701",
        labels,
        policies: [published],
        existing: Option.some(rule),
      }),
    ),
    Scene.expect(Scene.role("combobox", { name: "When it matches" })).toExist(),
    Scene.expect(Scene.role("combobox", { name: "When it does not match" })).toExist(),
  )
})
