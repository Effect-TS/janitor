import * as DateTime from "effect/DateTime"
import * as Option from "effect/Option"
import { Story } from "foldkit/test"
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
  onNoMatch: "preserve",
  group: "size",
  priority: 3,
  enabled: true,
  labelStatus: "valid",
  version: 1,
  createdAt: at,
  updatedAt: at,
}

describe("RuleEditor", () => {
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
