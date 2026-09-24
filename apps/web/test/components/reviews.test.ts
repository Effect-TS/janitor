import { TeammateId } from "@janitor/domain/Team/Account"
import * as DateTime from "effect/DateTime"
import { Scene, Story } from "foldkit/test"
import { describe, expect, it } from "vite-plus/test"
import type { ReviewRun } from "@janitor/domain/Review/Run"
import { ReviewRunId } from "@janitor/domain/Review/Run"
import * as Reviews from "@/components/reviews"
import * as Dialog from "@foldkit/ui/dialog"
import * as Sheet from "@/components/ui/sheet"

const at = DateTime.makeUnsafe("2026-09-17T12:00:00.000Z")
const run = (id: string, status: ReviewRun["status"], queuePosition: number | null): ReviewRun => ({
  runId: ReviewRunId.make(id),
  repositoryId: "701",
  issueNumber: 20,
  issueTitle: "Scheduler stalls",
  commentId: id,
  invokerId: "9",
  invokerLogin: "octocat",
  instructions: "/janitor is this a regression?",
  dryRun: true,
  status,
  queuePosition,
  acceptedAt: at,
  startedAt: status === "running" ? at : null,
  deadlineAt: status === "running" ? DateTime.add(at, { minutes: 15 }) : null,
  finishedAt: status === "cancelled" ? at : null,
  cancelReason: status === "cancelled" ? "The issue was closed." : null,
  cancelledBy: null,
  classification: null,
  defaultBranch: null,
  commitSha: null,
  findings: null,
  uncertainty: null,
  evidence: [],
  reproduction: { patch: null, attempts: [], assessment: null },
  draftPublication: null,
  publication: { status: "none", body: null, commentId: null, url: null, reason: null },
  limitation: null,
})
const runs = [run("a", "running", 1), run("b", "queued", 2), run("c", "cancelled", null)]

const concluded: ReviewRun = {
  ...run("d", "completed", null),
  classification: "question",
  defaultBranch: "main",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  findings: "Retries are configured in src/config.ts.\n\nSee #31 for the earlier answer.",
  uncertainty: "The README may lag the code.",
  evidence: [
    {
      kind: "issue",
      reference: "31",
      note: "Earlier report.",
      verified: true,
      url: "https://github.com/effect/one/issues/31",
    },
    { kind: "pull_request", reference: "99", note: "Never opened.", verified: false, url: null },
  ],
  limitation: null,
}
const stopped: ReviewRun = {
  ...run("e", "interrupted", null),
  defaultBranch: "main",
  commitSha: "fedcba9876543210fedcba9876543210fedcba98",
  limitation: "The sandbox workspace was lost before the investigation finished.",
  evidence: [
    {
      kind: "file",
      reference: "README.md",
      note: "Inspected during the run.",
      verified: true,
      url: null,
    },
  ],
}

const activated = () =>
  Reviews.update(Reviews.init(), Reviews.Message.Activated({ repositoryId: "701", active: true }))

const selected = (model: Reviews.Model, runId: string): Reviews.Model => ({
  ...model,
  selectedRunId: runId,
  drawer: Sheet.boot({ id: "review-details", isAnimated: false }).model,
})

describe("Reviews", () => {
  it("shows Publish results only when eligible and renders every saved publication outcome", () => {
    const eligible = { ...concluded, canPublish: true }
    const outcomes = ["pending", "completed", "blocked", "partial", "unresolved"] as const
    const history = outcomes.map((status, i) => ({
      ...concluded,
      runId: ReviewRunId.make(`saved-${i}`),
      savedPublication: {
        teammateId: TeammateId.make("member"),
        githubId: "21",
        githubLogin: "stranger",
        requestedAt: "2026-09-18T12:00:00Z",
        status,
      },
    }))
    Scene.scene(
      { update: Reviews.update, view: Scene.withViewInputs(Reviews.view, {})() },
      Scene.given(
        selected(
          { ...activated().model, loading: false, runs: [eligible, ...history] },
          eligible.runId,
        ),
      ),
      Scene.Mount.resolve(Dialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
      Scene.expectAll(Scene.all.role("button", { name: "Publish results" })).toHaveCount(1),

      Scene.click(Scene.role("button", { name: "Publish results" })),
      Scene.expect(Scene.role("button", { name: "Publishing…" })).toExist(),
      Scene.Command.resolve(
        Reviews.PublishRun({ repositoryId: "701", runId: eligible.runId, generation: 1 }),
        Reviews.Message.Published({
          runId: eligible.runId,
          generation: 1,
          publication: history[0]!.savedPublication,
        }),
      ),
    )
    for (const saved of history) {
      Scene.scene(
        { update: Reviews.update, view: Scene.withViewInputs(Reviews.view, {})() },
        Scene.given(selected({ ...activated().model, runs: [saved] }, saved.runId)),
        Scene.Mount.resolve(Dialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
        Scene.expect(
          Scene.text(`Publication: ${saved.savedPublication.status}. Authorized by stranger.`),
        ).toExist(),
        Scene.expect(Scene.role("button", { name: "Publish results" })).toBeAbsent(),
      )
    }
  })

  it("publishes only eligible results, ignores duplicate clicks, and retains the durable outcome", () => {
    const ready = { ...concluded, canPublish: true }
    const model = { ...activated().model, loading: false, runs: [ready] }
    const clicked = Reviews.update(model, Reviews.Message.ClickedPublish({ runId: ready.runId }))
    expect(clicked.model.publishing).toBe(ready.runId)
    expect(
      Reviews.update(clicked.model, Reviews.Message.ClickedPublish({ runId: ready.runId }))
        .commands,
    ).toBeUndefined()
    const publication = {
      teammateId: TeammateId.make("member"),
      githubId: "21",
      githubLogin: "stranger",
      requestedAt: "2026-09-18T12:00:00Z",
      status: "pending" as const,
    }
    const done = Reviews.update(
      clicked.model,
      Reviews.Message.Published({ runId: ready.runId, generation: model.generation, publication }),
    )
    expect(done.model.runs[0]?.savedPublication).toEqual(publication)
    expect(done.model.runs[0]?.canPublish).toBe(false)
    expect(done.model.publishing).toBeNull()
    expect(
      Reviews.update(
        { ...model, runs: [concluded] },
        Reviews.Message.ClickedPublish({ runId: concluded.runId }),
      ).commands,
    ).toBeUndefined()
  })

  it("loads the history when activated, fences stale answers, and refreshes after a cancel", () => {
    Story.story(
      Reviews.update,
      Story.given(Reviews.init()),
      Story.message(Reviews.Message.Activated({ repositoryId: "701", active: true })),
      Story.Command.resolve(
        Reviews.FetchHistory({ repositoryId: "701", generation: 1 }),
        Reviews.Message.Loaded({ generation: 0, runs }),
      ),
      Story.model((next) => expect(next.runs).toEqual([])),
      Story.message(Reviews.Message.Loaded({ generation: 1, runs })),
      Story.model((next) => {
        expect(next.runs).toHaveLength(3)
        expect(next.initialized).toBe(true)
      }),
      // A finished run has no queue position and cannot be cancelled.
      Story.message(Reviews.Message.ClickedCancel({ runId: "c" })),
      Story.model((next) => expect(next.cancelling).toBeNull()),
      Story.message(Reviews.Message.ClickedCancel({ runId: "b" })),
      Story.model((next) => {
        expect(next.cancelling).toBe("b")
        // A second click while one cancellation is in flight is ignored.
        expect(Reviews.update(next, Reviews.Message.ClickedCancel({ runId: "a" })).commands).toBe(
          undefined,
        )
      }),
      Story.Command.resolve(
        Reviews.CancelRun({ repositoryId: "701", runId: "b" }),
        Reviews.Message.Cancelled({ runId: "b", status: "cancelled" }),
      ),
      Story.expectOutMessage(
        Reviews.OutMessage.Notified({
          title: "Review run cancelled",
          description:
            "Later runs on the same issue stay queued; completed publications are untouched.",
        }),
      ),
      Story.model((next) => {
        expect(next.cancelling).toBeNull()
        expect(next.loading).toBe(true)
      }),
      Story.Command.resolve(
        Reviews.FetchHistory({ repositoryId: "701", generation: 1 }),
        Reviews.Message.Loaded({ generation: 1, runs: runs.slice(0, 1) }),
      ),
      Story.model((next) => expect(next.runs).toHaveLength(1)),
    )
  })

  it("reports a refused cancellation with the server's reason", () => {
    const { model, commands } = activated()
    expect(commands?.map((command) => command.name)).toEqual(["FetchReviewHistory"])
    Story.story(
      Reviews.update,
      Story.given({ ...model, loading: false, initialized: true, runs }),
      Story.message(Reviews.Message.ClickedCancel({ runId: "a" })),
      Story.Command.resolve(
        Reviews.CancelRun({ repositoryId: "701", runId: "a" }),
        Reviews.Message.CancelFailed({ runId: "a", reason: "Connect your GitHub account." }),
      ),
      Story.expectOutMessage(
        Reviews.OutMessage.Failed({
          title: "The run was not cancelled",
          reason: "Connect your GitHub account.",
        }),
      ),
      Story.model((next) => expect(next.cancelling).toBeNull()),
    )
  })

  it("shows queue positions, cancellation reasons, and a cancel button only for live runs", () => {
    const { model } = activated()
    const loaded = { ...model, loading: false, initialized: true, runs }
    expect(Reviews.statusLabel(runs[1]!)).toBe("queued #2")
    expect(Reviews.statusLabel(runs[0]!)).toBe("running")
    Scene.scene(
      { update: Reviews.update, view: Scene.withViewInputs(Reviews.view, {})() },
      Scene.given(selected(loaded, "a")),
      Scene.Mount.resolve(Dialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
      Scene.expect(Scene.text("queued #2")).toExist(),

      Scene.expectAll(Scene.all.role("button", { name: "Cancel run" })).toHaveCount(1),
      Scene.click(Scene.role("button", { name: "Cancel run" })),
      Scene.expect(Scene.role("button", { name: "Cancelling…" })).toExist(),
      Scene.Command.resolve(
        Reviews.CancelRun({ repositoryId: "701", runId: "a" }),
        Reviews.Message.CancelFailed({ runId: "a", reason: "Connect your GitHub account." }),
      ),
      Scene.expect(Scene.role("button", { name: "Cancelling…" })).toBeAbsent(),
    )
  })

  it("shows a concluded run's findings, evidence links, and a stopped run's limitation", () => {
    const { model } = activated()
    const loaded = { ...model, loading: false, initialized: true, runs: [concluded, stopped] }
    Scene.scene(
      { update: Reviews.update, view: Scene.withViewInputs(Reviews.view, {})() },
      Scene.given(selected(loaded, concluded.runId)),
      Scene.Mount.resolve(Dialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
      Scene.expect(Scene.text("question")).toExist(),
      Scene.expect(Scene.text("Retries are configured in src/config.ts.")).toExist(),
      Scene.expect(Scene.text("The README may lag the code.")).toExist(),
      Scene.click(Scene.role("button", { name: "Evidence 2" })),
      Scene.expect(Scene.role("link", { name: "issue #31" })).toExist(),
      Scene.expect(Scene.text("PR #99")).toExist(),
      Scene.expect(Scene.text("not observed in this run")).toExist(),
      Scene.expect(Scene.text("0123456789ab")).toExist(),
      // Concluded and stopped runs cannot be cancelled.
      Scene.expectAll(Scene.all.role("button", { name: "Cancel run" })).toHaveCount(0),
    )
  })
  it("keeps details out of the table, opens a run, and retains its selection through live updates", () => {
    const model = {
      ...activated().model,
      loading: false,
      initialized: true,
      runs: [concluded, stopped],
    }
    Scene.scene(
      { update: Reviews.update, view: Scene.withViewInputs(Reviews.view, {})() },
      Scene.given(model),
      Scene.expect(Scene.text(concluded.instructions)).toBeAbsent(),
      Scene.expect(Scene.text("Retries are configured in src/config.ts.")).toBeAbsent(),
      Scene.expect(Scene.role("button", { name: "View run d for issue #20" })).toExist(),
    )
    const opened = Reviews.update(model, Reviews.Message.ClickedRun({ runId: "d" }))
    expect(opened.model.drawer.isOpen).toBe(true)
    expect(opened.commands?.some((command) => command.name === "ShowDialog")).toBe(true)
    const changed = Reviews.update(
      opened.model,
      Reviews.Message.ClickedDetailTab({ tab: "Evidence" }),
    ).model
    const refreshed = Reviews.update(
      changed,
      Reviews.Message.Loaded({
        generation: changed.generation,
        runs: [{ ...concluded, findings: "Updated findings" }, stopped],
      }),
    ).model
    expect(refreshed.selectedRunId).toBe("d")
    expect(refreshed.detailTab).toBe("Evidence")
    expect(refreshed.drawer.isOpen).toBe(true)
    const navigated = Reviews.update(
      refreshed,
      Reviews.Message.Activated({ repositoryId: "another", active: true }),
    ).model
    expect(navigated.selectedRunId).toBeNull()
    expect(navigated.drawer.isOpen).toBe(false)
    expect(navigated.runs).toEqual([])
  })

  it("shows interruption and cancellation explanations in the selected drawer", () => {
    for (const item of [stopped, runs[2]!]) {
      Scene.scene(
        { update: Reviews.update, view: Scene.withViewInputs(Reviews.view, {})() },
        Scene.given(selected({ ...activated().model, runs: [item] }, item.runId)),
        Scene.Mount.resolve(Dialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
        Scene.expect(Scene.text(item.limitation ?? item.cancelReason!)).toExist(),
        Scene.expect(Scene.role("button", { name: "Cancel run" })).toBeAbsent(),
      )
    }
  })

  it("filters the history and keeps an empty filter distinct from an empty history", () => {
    Scene.scene(
      { update: Reviews.update, view: Scene.withViewInputs(Reviews.view, {})() },
      Scene.given({ ...activated().model, loading: false, runs }),
      Scene.click(Scene.role("button", { name: "Active 2" })),
      Scene.expect(Scene.role("button", { name: "View run c for issue #20" })).toBeAbsent(),
      Scene.click(Scene.role("button", { name: "Failed 0" })),
      Scene.expect(Scene.text("No runs match this filter.")).toExist(),
    )
  })

  it("keeps command output and test patches in their own detail sections", () => {
    const reproduced: ReviewRun = {
      ...concluded,
      reproduction: {
        assessment: {
          outcome: "reproduced",
          rationale: "The regression test fails.",
          unverified: "Other environments were not tested.",
          attemptIds: ["test-1"],
          duplicate: null,
        },
        attempts: [
          {
            id: "test-1",
            patchId: "patch-1",
            commitSha: concluded.commitSha!,
            kind: "test",
            command: "vp test regression.test.ts",
            testPath: "regression.test.ts",
            exitCode: 1,
            output: "Expected false, received true",
            truncated: true,
            integrity: true,
            limitation: null,
          },
        ],
        patch: {
          id: "patch-1",
          baseCommit: concluded.commitSha!,
          diff: "+ regression test",
          files: [
            {
              path: "regression.test.ts",
              content: "test",
              rationale: "Covers the reported failure.",
            },
          ],
        },
      },
    }
    Scene.scene(
      { update: Reviews.update, view: Scene.withViewInputs(Reviews.view, {})() },
      Scene.given(selected({ ...activated().model, runs: [reproduced] }, reproduced.runId)),
      Scene.Mount.resolve(Dialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
      Scene.expect(Scene.text("The regression test fails.")).toExist(),
      Scene.expect(Scene.text("Expected false, received true")).toBeAbsent(),
      Scene.click(Scene.role("button", { name: "Execution" })),
      Scene.expect(Scene.text("Expected false, received true")).toExist(),
      Scene.expect(Scene.text("Earlier output was truncated.")).toExist(),
      Scene.expect(Scene.text("+ regression test")).toBeAbsent(),
      Scene.click(Scene.role("button", { name: "Patch" })),
      Scene.expect(Scene.text("+ regression test")).toExist(),
      Scene.expect(Scene.text("Expected false, received true")).toBeAbsent(),
    )
  })
})
