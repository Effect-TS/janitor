import * as DateTime from "effect/DateTime"
import * as Option from "effect/Option"
import { Scene, Story } from "foldkit/test"
import { describe, expect, it } from "vite-plus/test"
import type { PolicyDetail } from "@/components/labeling-wire"
import * as PolicyEditor from "@/components/policy-editor"
import * as PolicySource from "@/components/policy-source"
import * as TestBench from "@/components/test-bench"

const at = DateTime.makeUnsafe("2026-09-03T14:00:00.000Z")
const detail: PolicyDetail = {
  policy: {
    policyId: "p1",
    repositoryId: "701",
    name: "Base is main",
    target: "pull_request",
    description: "",
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

const fresh = () =>
  PolicyEditor.init({
    repositoryId: "701",
    configuration: {
      repositoryId: "701",
      configuredRevision: 0,
      activeRevision: null,
      pendingTracks: [],
      policies: [],
      rules: [],
      labels: [],
      labelFreshness: "verified",
    },
    catalog: [],
    policyNames: ["Ready"],
    existing: Option.none(),
    testCandidates: {
      _tag: "Ready",
      items: [
        {
          number: 7,
          kind: "issue",
          title: "Bug report",
          authorLogin: "octocat",
          baseRef: null,
          draft: null,
          labels: [],
          evaluation: null,
          plan: null,
        },
        {
          number: 5,
          kind: "pull_request",
          title: "Fix a bug",
          authorLogin: "octocat",
          baseRef: "main",
          draft: false,
          labels: [],
          evaluation: null,
          plan: null,
        },
        {
          number: 6,
          kind: "pull_request",
          title: "Add a feature",
          authorLogin: "octocat",
          baseRef: "next",
          draft: false,
          labels: [],
          evaluation: null,
          plan: null,
        },
      ],
    },
  })

describe("PolicyEditor", () => {
  it("separates saved input from publication status, including invalid YAML and publish failures", () => {
    expect(PolicyEditor.saveStatus(fresh())).toBe("Not saved yet")
    expect(PolicyEditor.publicationStatus(fresh()).published).toBe(false)
    let model = {
      ...fresh(),
      name: detail.policy.name,
      savedFields: { ...fresh().savedFields, name: detail.policy.name },
      identity: { _tag: "Existing" as const, policyId: "p1", version: 1 },
      hasBeenPublished: true,
      publishedRevision: 3,
      publishedSource: Option.some(detail.draft),
    }
    expect(PolicyEditor.saveStatus(model)).toBe("Saved")
    expect(PolicyEditor.publicationStatus(model)).toEqual({
      published: true,
      revision: 3,
      changes: false,
    })
    const renamed = PolicyEditor.update(
      model,
      PolicyEditor.Message.UpdatedName({ value: "New title" }),
    ).model
    expect(PolicyEditor.saveStatus(renamed)).toBe("Unsaved changes")
    expect(PolicyEditor.publicationStatus(renamed).changes).toBe(false)
    const invalid = PolicyEditor.update(
      model,
      PolicyEditor.Message.GotSourceMessage({
        message: PolicySource.Message.EditedSource({ source: "target: [" }),
      }),
    ).model
    expect(PolicyEditor.publicationStatus(invalid).changes).toBe(true)
    expect(PolicyEditor.saveStatus(invalid)).toBe("Unsaved changes")
    const failed = PolicyEditor.update(
      renamed,
      PolicyEditor.Message.FailedSavePolicy({ reason: "Offline" }),
    ).model
    expect(PolicyEditor.saveStatus(failed)).toBe("Save failed")
    const publishFailed = PolicyEditor.update(
      model,
      PolicyEditor.Message.SavedDraftWithPublishError({ detail, reason: "Cannot publish" }),
    ).model
    expect(PolicyEditor.saveStatus(publishFailed)).toBe("Saved")
  })
  it.each(["title", "description"])(
    "discards the %s edit when focus leaves its controls",
    (field) => {
      Scene.scene(
        {
          update: PolicyEditor.update,
          view: Scene.withViewInputs(PolicyEditor.view, { confirmingDelete: false })(),
        },
        Scene.given(fresh()),
        Scene.Mount.resolve(
          PolicySource.MountPolicySourceEditor,
          PolicySource.Message.MountedEditor(),
        ),
        Scene.click(Scene.role("button", { name: `Edit ${field}` })),
        Scene.Mount.resolve(
          PolicyEditor.FocusMetadataInput,
          PolicyEditor.Message.FocusedMetadataInput(),
        ),
        Scene.type(
          Scene.role("textbox", { name: field === "title" ? "Title" : "Description" }),
          "Discard me",
        ),
        Scene.focusLeave(".policy-metadata-form"),
        Scene.Mount.expectEnded(PolicyEditor.FocusMetadataInput),
        Scene.expect(
          Scene.role("textbox", { name: field === "title" ? "Title" : "Description" }),
        ).toBeAbsent(),
        Scene.expect(Scene.role("button", { name: "Save draft" })).toBeAbsent(),
      )
    },
  )
  it("cancels title and description edits with Escape without dirtying the draft", () => {
    Scene.scene(
      {
        update: PolicyEditor.update,
        view: Scene.withViewInputs(PolicyEditor.view, { confirmingDelete: false })(),
      },
      Scene.given({
        ...fresh(),
        name: "Original",
        savedFields: { ...fresh().savedFields, name: "Original" },
      }),
      Scene.Mount.resolve(
        PolicySource.MountPolicySourceEditor,
        PolicySource.Message.MountedEditor(),
      ),
      Scene.click(Scene.role("button", { name: "Original" })),
      Scene.Mount.resolve(
        PolicyEditor.FocusMetadataInput,
        PolicyEditor.Message.FocusedMetadataInput(),
      ),
      Scene.type(Scene.role("textbox", { name: "Title" }), "Discard this"),
      Scene.keydown(Scene.role("textbox", { name: "Title" }), "Escape"),
      Scene.Mount.expectEnded(PolicyEditor.FocusMetadataInput),
      Scene.expect(Scene.role("textbox", { name: "Title" })).toBeAbsent(),
      Scene.expect(Scene.role("button", { name: "Original" })).toExist(),
      Scene.click(Scene.role("button", { name: "Edit description" })),
      Scene.Mount.resolve(
        PolicyEditor.FocusMetadataInput,
        PolicyEditor.Message.FocusedMetadataInput(),
      ),
      Scene.type(Scene.role("textbox", { name: "Description" }), "Discard this too"),
      Scene.keydown(Scene.role("textbox", { name: "Description" }), "Escape"),
      Scene.Mount.expectEnded(PolicyEditor.FocusMetadataInput),
      Scene.expect(Scene.role("textbox", { name: "Description" })).toBeAbsent(),
      Scene.expect(Scene.role("button", { name: "Save draft" })).toBeAbsent(),
    )
  })
  it("shows publication status without repeating the permanent publish explanation", () => {
    Scene.scene(
      {
        update: PolicyEditor.update,
        view: Scene.withViewInputs(PolicyEditor.view, { confirmingDelete: false })(),
      },
      Scene.given({
        ...fresh(),
        name: detail.policy.name,
        hasBeenPublished: true,
        publishedRevision: 1,
        publishedSource: Option.some(detail.draft),
      }),
      Scene.Mount.resolve(
        PolicySource.MountPolicySourceEditor,
        PolicySource.Message.MountedEditor(),
      ),
      Scene.expect(Scene.role("button", { name: "Publish" })).toBeAbsent(),
      Scene.expect(Scene.text("Published · v1")).toExist(),
      Scene.expect(Scene.role("region", { name: "Versions" })).toExist(),
      Scene.expect(Scene.text("v1")).toExist(),
      Scene.expect(Scene.text("Working draft")).toBeAbsent(),
      Scene.expect(Scene.text("Draft changes take effect when published.")).toBeAbsent(),
    )
  })
  it("keeps metadata edits separate until Save and discards them on Cancel", () => {
    let model = { ...fresh(), name: "Original", description: "Original description" }
    const send = (message: PolicyEditor.Message) => {
      model = PolicyEditor.update(model, message).model
    }
    send(PolicyEditor.Message.ClickedEditMetadata({ field: "name" }))
    send(PolicyEditor.Message.UpdatedMetadataDraft({ field: "name", value: "Revised" }))
    expect(model.name).toBe("Original")
    send(PolicyEditor.Message.ClickedCancelMetadata({ field: "name" }))
    expect(model.name).toBe("Original")
    expect(model.metadataEdits.name).toBeNull()
    send(PolicyEditor.Message.ClickedEditMetadata({ field: "name" }))
    expect(model.metadataEdits.name).toBe("Original")
    send(PolicyEditor.Message.UpdatedMetadataDraft({ field: "name", value: " " }))
    send(PolicyEditor.Message.ClickedSaveMetadata({ field: "name" }))
    expect(model.name).toBe("Original")
    send(PolicyEditor.Message.UpdatedMetadataDraft({ field: "name", value: "Revised" }))
    send(PolicyEditor.Message.ClickedSaveMetadata({ field: "name" }))
    expect(model.name).toBe("Revised")
    expect(model.metadataEdits.name).toBeNull()
    send(PolicyEditor.Message.ClickedEditMetadata({ field: "description" }))
    send(PolicyEditor.Message.UpdatedMetadataDraft({ field: "description", value: "Discard me" }))
    send(PolicyEditor.Message.ClickedCancelMetadata({ field: "description" }))
    expect(model.description).toBe("Original description")
    send(PolicyEditor.Message.ClickedEditMetadata({ field: "description" }))
    send(PolicyEditor.Message.UpdatedMetadataDraft({ field: "description", value: "" }))
    send(PolicyEditor.Message.ClickedSaveMetadata({ field: "description" }))
    expect(model.description).toBe("")
    expect(model.metadataEdits.description).toBeNull()
  })
  it("publishes only program changes, ignoring comments, key order, and default values", () => {
    const model = {
      ...fresh(),
      name: detail.policy.name,
      hasBeenPublished: true,
      publishedSource: Option.some(detail.draft),
    }
    expect(PolicyEditor.hasChangesToPublish(model)).toBe(false)
    expect(
      PolicyEditor.update(model, PolicyEditor.Message.ClickedPublish()).commands ?? [],
    ).toEqual([])
    const source = (text: string) =>
      PolicyEditor.update(
        model,
        PolicyEditor.Message.GotSourceMessage({
          message: PolicySource.Message.EditedSource({ source: text }),
        }),
      ).model
    const same = source(
      "# Comment\nmatchesWhen:\n  value: main\n  caseSensitive: false\n  operator: equals\n  fact: baseRef\ntarget: pull_request\n",
    )
    expect(PolicyEditor.hasChangesToPublish(same)).toBe(false)
    expect(
      PolicyEditor.hasChangesToPublish(
        PolicyEditor.update(model, PolicyEditor.Message.UpdatedName({ value: "Renamed" })).model,
      ),
    ).toBe(false)
    const changed = source(model.source.source.replace("main", "next"))
    expect(PolicyEditor.hasChangesToPublish(changed)).toBe(true)
    const saving = PolicyEditor.update(changed, PolicyEditor.Message.ClickedSave()).model
    const changedDetail = {
      ...detail,
      draftDiffers: true,
      draft: Option.getOrThrow(PolicyEditor.parsedSource(changed)),
      publishedSource: detail.draft,
    }
    const saved = PolicyEditor.update(
      saving,
      PolicyEditor.Message.SucceededSavePolicy({ detail: changedDetail, published: false }),
    ).model
    expect(PolicyEditor.isDirty(saved)).toBe(false)
    expect(PolicyEditor.hasChangesToPublish(saved)).toBe(true)
    const reverted = PolicyEditor.update(
      saved,
      PolicyEditor.Message.GotSourceMessage({
        message: PolicySource.Message.EditedSource({ source: model.source.source }),
      }),
    ).model
    expect(PolicyEditor.hasChangesToPublish(reverted)).toBe(false)
    const publishing = PolicyEditor.update(saved, PolicyEditor.Message.ClickedPublish()).model
    const published = PolicyEditor.update(
      publishing,
      PolicyEditor.Message.SucceededSavePolicy({ detail: changedDetail, published: true }),
    ).model
    expect(PolicyEditor.hasChangesToPublish(published)).toBe(false)
    expect(
      PolicyEditor.update(published, PolicyEditor.Message.ClickedPublish()).commands ?? [],
    ).toEqual([])
  })

  it("keeps validation visible and removes the dependency section", () => {
    Scene.scene(
      {
        update: PolicyEditor.update,
        view: Scene.withViewInputs(PolicyEditor.view, { confirmingDelete: false })(),
      },
      Scene.given(fresh()),
      Scene.Mount.resolve(
        PolicySource.MountPolicySourceEditor,
        PolicySource.Message.MountedEditor(),
      ),
      Scene.expect(Scene.role("button", { name: "Validate" })).toExist(),
      Scene.expect(Scene.text("No rules use this policy yet.")).toBeAbsent(),
      Scene.expect(Scene.text("Reference a published policy inside a condition:")).toBeAbsent(),
      Scene.expect(Scene.role("button", { name: "Data & dependencies" })).toBeAbsent(),
    )
  })

  it("shows Save draft only for unsaved edits", () => {
    expect(PolicyEditor.isDirty(fresh())).toBe(false)
    Scene.scene(
      {
        update: PolicyEditor.update,
        view: Scene.withViewInputs(PolicyEditor.view, { confirmingDelete: false })(),
      },
      Scene.given({
        ...fresh(),
        name: "Original",
        savedFields: { ...fresh().savedFields, name: "Original" },
        hasBeenPublished: true,
      }),
      Scene.Mount.resolve(
        PolicySource.MountPolicySourceEditor,
        PolicySource.Message.MountedEditor(),
      ),
      Scene.expect(Scene.role("button", { name: "Save draft" })).toBeAbsent(),
      Scene.expect(Scene.role("textbox", { name: "Title" })).toBeAbsent(),
      Scene.click(Scene.role("button", { name: "Edit title" })),
      Scene.Mount.resolve(
        PolicyEditor.FocusMetadataInput,
        PolicyEditor.Message.FocusedMetadataInput(),
      ),
      Scene.type(Scene.role("textbox", { name: "Title" }), "Changed name"),
      Scene.expect(Scene.role("button", { name: "Save draft" })).toBeAbsent(),
      Scene.click(Scene.role("button", { name: "Save title" })),
      Scene.Mount.expectEnded(PolicyEditor.FocusMetadataInput),
      Scene.expect(Scene.role("button", { name: "Save draft" })).toExist(),
      Scene.click(Scene.role("button", { name: "Edit title" })),
      Scene.Mount.resolve(
        PolicyEditor.FocusMetadataInput,
        PolicyEditor.Message.FocusedMetadataInput(),
      ),
      Scene.type(Scene.role("textbox", { name: "Title" }), "Original"),
      Scene.click(Scene.role("button", { name: "Save title" })),
      Scene.Mount.expectEnded(PolicyEditor.FocusMetadataInput),
      Scene.expect(Scene.role("button", { name: "Save draft" })).toBeAbsent(),
      Scene.click(Scene.role("button", { name: "Edit description" })),
      Scene.Mount.resolve(
        PolicyEditor.FocusMetadataInput,
        PolicyEditor.Message.FocusedMetadataInput(),
      ),
      Scene.type(Scene.role("textbox", { name: "Description" }), "Changed description"),
      Scene.click(Scene.role("button", { name: "Save description" })),
      Scene.Mount.expectEnded(PolicyEditor.FocusMetadataInput),
      Scene.expect(Scene.role("button", { name: "Save draft" })).toExist(),
    )
  })

  it("tracks the saved YAML snapshot without clearing edits made during a save", () => {
    const model = { ...fresh(), hasBeenPublished: true, name: detail.policy.name }
    const changed = PolicyEditor.update(
      model,
      PolicyEditor.Message.GotSourceMessage({
        message: PolicySource.Message.EditedSource({
          source: model.source.source + "# explanation\n",
        }),
      }),
    ).model
    expect(PolicyEditor.isDirty(changed)).toBe(true)
    const saving = PolicyEditor.update(changed, PolicyEditor.Message.ClickedSave()).model
    const saved = PolicyEditor.update(
      saving,
      PolicyEditor.Message.SucceededSavePolicy({ detail, published: false }),
    ).model
    expect(PolicyEditor.isDirty(saved)).toBe(false)
    const editedDuringSave = PolicyEditor.update(
      saving,
      PolicyEditor.Message.UpdatedDescription({ value: "Still editing" }),
    ).model
    const completed = PolicyEditor.update(
      editedDuringSave,
      PolicyEditor.Message.SucceededSavePolicy({ detail, published: false }),
    ).model
    expect(PolicyEditor.isDirty(completed)).toBe(true)
    expect(completed.description).toBe("Still editing")
    const unpublished = PolicyEditor.update(
      { ...saving, hasBeenPublished: false },
      PolicyEditor.Message.SucceededSavePolicy({ detail, published: false }),
    ).model
    expect(PolicyEditor.isDirty(unpublished)).toBe(false)
    const published = PolicyEditor.update(
      { ...saving, hasBeenPublished: false },
      PolicyEditor.Message.SucceededSavePolicy({ detail, published: true }),
    ).model
    expect(PolicyEditor.isDirty(published)).toBe(false)
  })

  it("starts from a working program and requires a name before publishing", () => {
    const model = fresh()
    expect(PolicyEditor.draftIssues(model)).toEqual(["Name is required"])
    Story.story(
      PolicyEditor.update,
      Story.given(model),
      Story.message(PolicyEditor.Message.ClickedPublish()),
      Story.Command.expectNone(),
      Story.message(PolicyEditor.Message.UpdatedName({ value: "Base is main" })),
      Story.message(PolicyEditor.Message.ClickedPublish()),
      Story.model((next) =>
        expect(next.submission).toMatchObject({ _tag: "Submitting", publish: true }),
      ),
      Story.Command.resolve(
        PolicyEditor.SavePolicy({
          repositoryId: "701",
          identity: { _tag: "New" },
          name: "Base is main",
          description: "",
          source: {
            target: "pull_request",
            matchesWhen: { fact: "baseRef", operator: "equals", value: "main" },
          },
          publish: true,
        }),
        PolicyEditor.Message.SucceededSavePolicy({ detail, published: true }),
      ),
      Story.expectOutMessage(PolicyEditor.OutMessage.Saved({ detail, published: true })),
      Story.model((next) =>
        expect(next.identity).toEqual({ _tag: "Existing", policyId: "p1", version: 1 }),
      ),
    )
  })

  it("validates the draft and resets validation when the source changes", () => {
    Story.story(
      PolicyEditor.update,
      Story.given({ ...fresh(), name: "x" }),
      Story.message(PolicyEditor.Message.ClickedValidate()),
      Story.model((next) => expect(next.validation._tag).toBe("Validating")),
      Story.Command.resolve(
        PolicyEditor.ValidateDraft({
          repositoryId: "701",
          requestId: 1,
          source: {
            target: "pull_request",
            matchesWhen: { fact: "baseRef", operator: "equals", value: "main" },
          },
        }),
        PolicyEditor.Message.CompletedValidate({
          requestId: 1,
          response: {
            _tag: "Valid",
            manifest: {
              facts: ["baseRef"],
              tracks: ["pull_requests"],
              references: [],
              nodeCount: 1,
              expandedNodeCount: 1,
            },
          },
        }),
      ),
      Story.model((next) => expect(next.validation._tag).toBe("Valid")),
      Story.message(
        PolicyEditor.Message.GotSourceMessage({
          message: { _tag: "EditedSource", source: "{ not json" },
        }),
      ),
      Story.model((next) => {
        expect(next.validation._tag).toBe("NotValidated")
        expect(PolicyEditor.draftIssues(next)[0]).toContain("YAML")
      }),
    )
  })

  it("keeps the draft and moves the version forward on a conflict", () => {
    Story.story(
      PolicyEditor.update,
      Story.given({ ...fresh(), name: "x" }),
      Story.message(
        PolicyEditor.Message.ConflictedSavePolicy({
          detail: { ...detail, policy: { ...detail.policy, version: 4 } },
        }),
      ),
      Story.model((next) => {
        expect(next.identity).toEqual({ _tag: "Existing", policyId: "p1", version: 4 })
        expect(next.submission._tag).toBe("Conflicted")
        expect(next.name).toBe("x")
      }),
      Story.expectNoOutMessage(),
    )
  })
})

describe("PolicyEditor asynchronous edits", () => {
  it("ignores validation results after editing and starting another validation", () => {
    const validating = PolicyEditor.update(fresh(), PolicyEditor.Message.ClickedValidate()).model
    const edited = PolicyEditor.update(
      validating,
      PolicyEditor.Message.GotSourceMessage({
        message: { _tag: "EditedSource", source: "target: issue\nmatchesWhen:\n  policy: Ready\n" },
      }),
    ).model
    const validatingAgain = PolicyEditor.update(
      edited,
      PolicyEditor.Message.ClickedValidate(),
    ).model
    expect(validatingAgain.validation).toEqual({ _tag: "Validating", requestId: 2 })
    const stale = PolicyEditor.update(
      validatingAgain,
      PolicyEditor.Message.CompletedValidate({
        requestId: 1,
        response: { _tag: "Invalid", message: "Old source is invalid" },
      }),
    )
    expect(stale.model.validation).toEqual({ _tag: "Validating", requestId: 2 })
    const staleFailure = PolicyEditor.update(
      stale.model,
      PolicyEditor.Message.FailedValidate({
        requestId: 1,
        reason: "Old request failed",
      }),
    )
    expect(staleFailure.model.validation).toEqual({ _tag: "Validating", requestId: 2 })
    const completed = PolicyEditor.update(
      staleFailure.model,
      PolicyEditor.Message.CompletedValidate({
        requestId: 2,
        response: { _tag: "Invalid", message: "Current error" },
      }),
    )
    expect(completed.model.validation).toEqual({ _tag: "Invalid", message: "Current error" })
  })

  it("retains edits made during a save and prevents a second submission", () => {
    const saving = PolicyEditor.update(
      { ...fresh(), name: "Original" },
      PolicyEditor.Message.ClickedSave(),
    ).model
    const renamed = PolicyEditor.update(
      saving,
      PolicyEditor.Message.UpdatedName({ value: "Revised" }),
    ).model
    const edited = PolicyEditor.update(
      renamed,
      PolicyEditor.Message.UpdatedDescription({ value: "More detail" }),
    ).model
    expect(edited.submission._tag).toBe("Submitting")
    expect(PolicyEditor.update(edited, PolicyEditor.Message.ClickedSave()).commands).toBeUndefined()
    expect(
      PolicyEditor.update(edited, PolicyEditor.Message.ClickedCancel()).outMessage,
    ).toBeUndefined()
    const saved = PolicyEditor.update(
      edited,
      PolicyEditor.Message.SucceededSavePolicy({ detail, published: false }),
    )
    expect(saved.model.name).toBe("Revised")
    expect(saved.model.description).toBe("More detail")
    expect(saved.model.identity).toEqual({ _tag: "Existing", policyId: "p1", version: 1 })
    expect(saved.outMessage).toBeUndefined()
    expect(saved.model.submission._tag).toBe("NotSubmitted")
  })

  it("retains source changes made during a save", () => {
    const saving = PolicyEditor.update(
      { ...fresh(), name: "Original" },
      PolicyEditor.Message.ClickedSave(),
    ).model
    const source = "target: issue\nmatchesWhen:\n  policy: Ready\n"
    const edited = PolicyEditor.update(
      saving,
      PolicyEditor.Message.GotSourceMessage({
        message: { _tag: "EditedSource", source },
      }),
    ).model
    const saved = PolicyEditor.update(
      edited,
      PolicyEditor.Message.SucceededSavePolicy({ detail, published: false }),
    )
    expect(saved.model.source.source).toBe(source)
    expect(saved.outMessage).toBeUndefined()
  })

  it("retains the saved policy identity when publication fails", () => {
    const saving = PolicyEditor.update(
      { ...fresh(), name: "Original" },
      PolicyEditor.Message.ClickedPublish(),
    ).model
    const failed = PolicyEditor.update(
      saving,
      PolicyEditor.Message.SavedDraftWithPublishError({
        detail,
        reason: "Referenced policy is not published",
      }),
    )
    expect(failed.model.identity).toEqual({ _tag: "Existing", policyId: "p1", version: 1 })
    expect(failed.model.submission).toEqual({
      _tag: "SubmitError",
      draftSaved: true,
      message: "Saved as a draft, not published: Referenced policy is not published",
    })
    expect(failed.outMessage).toBeUndefined()
    const retry = PolicyEditor.update(failed.model, PolicyEditor.Message.ClickedSave())
    expect(retry.model.submission._tag).toBe("Submitting")
    expect(retry.commands).toHaveLength(1)
  })

  it("rejects unknown authoring keys rather than silently removing them", () => {
    const edited = PolicyEditor.update(
      { ...fresh(), name: "Named" },
      PolicyEditor.Message.GotSourceMessage({
        message: {
          _tag: "EditedSource",
          source: "target: issue\nmatchesWhen:\n  policy: Ready\napplyWhen: true\n",
        },
      }),
    ).model
    expect(Option.isNone(PolicyEditor.parsedSource(edited))).toBe(true)
    expect(PolicyEditor.update(edited, PolicyEditor.Message.ClickedSave()).commands).toBeUndefined()
  })
})

describe("YAML policy references", () => {
  it("saves a policy that combines another policy with a local condition", () => {
    const source = {
      target: "pull_request" as const,
      matchesWhen: {
        all: [
          { policy: "Ready for review" },
          { fact: "baseRef", operator: "equals", value: "main" },
        ],
      },
    }
    Story.story(
      PolicyEditor.update,
      Story.given({ ...fresh(), name: "Ready on main" }),
      Story.message(
        PolicyEditor.Message.GotSourceMessage({
          message: {
            _tag: "EditedSource",
            source: [
              "target: pull_request",
              "matchesWhen:",
              "  all:",
              "    - policy: Ready for review",
              "    - fact: baseRef",
              "      operator: equals",
              "      value: main",
            ].join("\n"),
          },
        }),
      ),
      Story.model((next) => expect(PolicyEditor.draftIssues(next)).toEqual([])),
      Story.message(PolicyEditor.Message.ClickedSave()),
      Story.Command.resolve(
        PolicyEditor.SavePolicy({
          repositoryId: "701",
          identity: { _tag: "New" },
          name: "Ready on main",
          description: "",
          source,
          publish: false,
        }),
        PolicyEditor.Message.SucceededSavePolicy({ detail, published: false }),
      ),
      Story.expectOutMessage(PolicyEditor.OutMessage.Saved({ detail, published: false })),
    )
  })
})

describe("testing an unsaved draft", () => {
  it("selects an item before testing and sends only its number", () => {
    const initial = fresh()
    expect(initial.maybeTestBench).toEqual(Option.none())
    const selected = PolicyEditor.update(
      initial,
      PolicyEditor.Message.SelectedTestItem({ number: 6 }),
    )
    expect(selected.commands ?? []).toEqual([])
    expect(PolicyEditor.selectedTestItem(selected.model)?.number).toBe(6)
    const tested = PolicyEditor.update(selected.model, PolicyEditor.Message.ClickedTestDraft())
    expect(Option.getOrThrow(tested.model.maybeTestBench).numbers).toEqual([6])
    const switched = PolicyEditor.update(
      tested.model,
      PolicyEditor.Message.SelectedTestItem({ number: 5 }),
    ).model
    expect(switched.maybeTestBench).toEqual(Option.none())
    const stale = PolicyEditor.update(
      switched,
      PolicyEditor.Message.GotTestBenchMessage({
        generation: tested.model.testGeneration,
        message: TestBench.Message.CompletedRunTest({
          response: { _tag: "Evaluated", entities: [] },
        }),
      }),
    ).model
    expect(stale.maybeTestBench).toEqual(Option.none())
    const empty = { ...initial, testCandidates: { _tag: "Ready" as const, items: [] } }
    expect(
      PolicyEditor.update(empty, PolicyEditor.Message.ClickedTestDraft()).commands ?? [],
    ).toEqual([])
  })

  it("runs current YAML without saving and includes existing identity for reference validation", () => {
    const source = "target: pull_request\nmatchesWhen:\n  policy: Ready\n"
    const model = PolicyEditor.update(
      {
        ...fresh(),
        identity: { _tag: "Existing", policyId: "p1", version: 1 },
      },
      PolicyEditor.Message.GotSourceMessage({ message: { _tag: "EditedSource", source } }),
    ).model
    Story.story(
      PolicyEditor.update,
      Story.given(model),
      Story.message(PolicyEditor.Message.ClickedTestDraft()),
      Story.model((next) => {
        expect(next.source.source).toBe(source)
        expect(next.submission._tag).toBe("NotSubmitted")
        expect(Option.getOrThrow(next.maybeTestBench).subject).toEqual({
          _tag: "Draft",
          source: { target: "pull_request", matchesWhen: { policy: "Ready" } },
          policyId: "p1",
        })
      }),
      Story.Command.resolve(
        TestBench.RunTest({
          numbers: [5],
          repositoryId: "701",
          subject: {
            _tag: "Draft",
            source: { target: "pull_request", matchesWhen: { policy: "Ready" } },
            policyId: "p1",
          },
        }),
        TestBench.Message.CompletedRunTest({ response: { _tag: "Evaluated", entities: [] } }),
      ),
      Story.model((next) =>
        expect(Option.getOrThrow(next.maybeTestBench).run._tag).toBe("Evaluated"),
      ),
      Story.expectNoOutMessage(),
    )
  })

  it("clears results on source edits and ignores previous runs after starting a new test", () => {
    const running = PolicyEditor.update(fresh(), PolicyEditor.Message.ClickedTestDraft()).model
    const edited = PolicyEditor.update(
      running,
      PolicyEditor.Message.GotSourceMessage({
        message: { _tag: "EditedSource", source: "target: issue\nmatchesWhen:\n  policy: Ready\n" },
      }),
    ).model
    expect(Option.isNone(edited.maybeTestBench)).toBe(true)
    const rerunning = PolicyEditor.update(edited, PolicyEditor.Message.ClickedTestDraft()).model
    const stale = PolicyEditor.update(
      rerunning,
      PolicyEditor.Message.GotTestBenchMessage({
        generation: 1,
        message: TestBench.Message.CompletedRunTest({
          response: { _tag: "Evaluated", entities: [] },
        }),
      }),
    ).model
    expect(Option.getOrThrow(stale.maybeTestBench).run._tag).toBe("Running")
    const closed = PolicyEditor.update(
      stale,
      PolicyEditor.Message.GotTestBenchMessage({
        generation: 2,
        message: TestBench.Message.ClickedClose(),
      }),
    )
    expect(Option.isNone(closed.model.maybeTestBench)).toBe(true)
    expect(closed.outMessage).toBeUndefined()
    expect(closed.model.source.source).toBe(edited.source.source)
  })

  it("shows draft results inline and keeps the editor open", () => {
    Scene.scene(
      {
        update: PolicyEditor.update,
        view: Scene.withViewInputs(PolicyEditor.view, { confirmingDelete: false })(),
      },
      Scene.given(fresh()),
      Scene.Mount.resolve(
        PolicySource.MountPolicySourceEditor,
        PolicySource.Message.MountedEditor(),
      ),
      Scene.click(Scene.role("button", { name: "Test draft" })),
      Scene.expect(Scene.text("Test bench")).toExist(),
      Scene.expect(Scene.role("button", { name: "Edit title" })).toExist(),
      Scene.Command.resolve(
        TestBench.RunTest({
          numbers: [5],
          repositoryId: "701",
          subject: {
            _tag: "Draft",
            source: {
              target: "pull_request",
              matchesWhen: { fact: "baseRef", operator: "equals", value: "main" },
            },
          },
        }),
        TestBench.Message.CompletedRunTest({ response: { _tag: "Evaluated", entities: [] } }),
      ),
      Scene.expect(Scene.text("No open issues or pull requests to test against yet.")).toExist(),
      Scene.click(Scene.role("button", { name: "Close" })),
      Scene.expect(Scene.role("button", { name: "Test draft" })).toExist(),
      Scene.expect(Scene.text("No open issues or pull requests to test against yet.")).toBeAbsent(),
      Scene.expect(Scene.role("button", { name: "Edit title" })).toExist(),
    )
  })
})

it("validates an existing draft with its identity to reject self references", () => {
  Story.story(
    PolicyEditor.update,
    Story.given({ ...fresh(), identity: { _tag: "Existing", policyId: "p1", version: 1 } }),
    Story.message(PolicyEditor.Message.ClickedValidate()),
    Story.Command.resolve(
      PolicyEditor.ValidateDraft({
        repositoryId: "701",
        policyId: "p1",
        requestId: 1,
        source: {
          target: "pull_request",
          matchesWhen: { fact: "baseRef", operator: "equals", value: "main" },
        },
      }),
      PolicyEditor.Message.CompletedValidate({
        requestId: 1,
        response: { _tag: "Invalid", message: "Cannot reference itself" },
      }),
    ),
    Story.model((next) =>
      expect(next.validation).toEqual({ _tag: "Invalid", message: "Cannot reference itself" }),
    ),
  )
})

it("rejects programs with both evaluator forms before submitting", () => {
  const model = PolicyEditor.update(
    { ...fresh(), name: "Ambiguous" },
    PolicyEditor.Message.GotSourceMessage({
      message: {
        _tag: "EditedSource",
        source:
          "target: issue\nmatchesWhen:\n  policy: Ready\nclassify:\n  prompt: Is this a bug?\n  evidence: [title]\n",
      },
    }),
  ).model
  expect(PolicyEditor.draftIssues(model)).toEqual([
    "The program needs exactly one of matchesWhen or classify",
  ])
  expect(PolicyEditor.update(model, PolicyEditor.Message.ClickedPublish()).commands ?? []).toEqual(
    [],
  )
})
