import { assert, describe, it } from "@effect/vitest"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import { RunStatus, Trigger } from "@janitor/domain/PullRequestReview/Run"

const decodes = (schema: Schema.Top, input: unknown) =>
  Exit.isSuccess(Schema.decodeUnknownExit(schema as Schema.Codec<unknown>)(input))

describe("PR review run", () => {
  it("decodes automatic, re-run and forced triggers", () => {
    assert.isTrue(decodes(Trigger, { _tag: "Automatic" }))
    assert.isTrue(decodes(Trigger, { _tag: "Rerun", invoker: "octocat", commentId: "2001" }))
    assert.isTrue(decodes(Trigger, { _tag: "Forced", invoker: "octocat", commentId: "2002" }))
    assert.isFalse(decodes(Trigger, { _tag: "Rerun" }))
  })

  it("decodes every run status and requires a known reason for a skip", () => {
    for (const status of [
      "running",
      "approved",
      "changes_requested",
      "commented",
      "partial",
      "failed",
      "cancelled",
    ]) {
      assert.isTrue(decodes(RunStatus, { status }), status)
    }
    assert.isTrue(decodes(RunStatus, { status: "skipped", reason: "oversized" }))
    assert.isTrue(decodes(RunStatus, { status: "skipped", reason: "run_cap" }))
    assert.isFalse(decodes(RunStatus, { status: "skipped" }))
    assert.isFalse(decodes(RunStatus, { status: "skipped", reason: "draft" }))
    assert.isFalse(decodes(RunStatus, { status: "resolved" }))
  })
})
