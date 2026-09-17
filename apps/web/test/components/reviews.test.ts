import * as DateTime from "effect/DateTime"
import { Scene, Story } from "foldkit/test"
import { describe, expect, it } from "vite-plus/test"
import type { ReviewRun } from "@janitor/domain/Review/Run"
import { ReviewRunId } from "@janitor/domain/Review/Run"
import * as Reviews from "@/components/reviews"

const at = DateTime.makeUnsafe("2026-09-17T12:00:00.000Z")
const run = (id: string, status: ReviewRun["status"], queuePosition: number | null): ReviewRun => ({
  runId: ReviewRunId.make(id),
  repositoryId: "701",
  issueNumber: 20,
  issueTitle: "Scheduler stalls",
  commentId: id,
  invokerId: "9",
  invokerLogin: "octocat",
  instructions: "@effect-janitor is this a regression?",
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

describe("Reviews", () => {
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
      Scene.given(loaded),
      Scene.expect(Scene.text("queued #2")).toExist(),
      Scene.expect(Scene.text("The issue was closed.")).toExist(),
      Scene.expectAll(Scene.all.role("button", { name: "Cancel run" })).toHaveCount(2),
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
      Scene.given(loaded),
      Scene.expect(Scene.text("question")).toExist(),
      Scene.expect(Scene.text("Retries are configured in src/config.ts.")).toExist(),
      Scene.expect(Scene.text("The README may lag the code.")).toExist(),
      Scene.expect(Scene.role("link", { name: "issue #31" })).toExist(),
      Scene.expect(Scene.text("PR #99")).toExist(),
      Scene.expect(Scene.text("not observed in this run")).toExist(),
      Scene.expect(Scene.text("0123456789ab")).toExist(),
      Scene.expect(
        Scene.text("The sandbox workspace was lost before the investigation finished."),
      ).toExist(),
      Scene.expect(Scene.text("README.md")).toExist(),
      // Concluded and stopped runs cannot be cancelled.
      Scene.expectAll(Scene.all.role("button", { name: "Cancel run" })).toHaveCount(0),
    )
  })
})
