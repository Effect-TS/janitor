import { assert, describe, it } from "@effect/vitest"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import { Finding, ThreadJudgement } from "@janitor/domain/PullRequestReview/Finding"

const decodes = (schema: Schema.Top, input: unknown) =>
  Exit.isSuccess(Schema.decodeUnknownExit(schema as Schema.Codec<unknown>)(input))

const finding = {
  path: "src/index.ts",
  startLine: 3,
  endLine: 3,
  severity: "blocking",
  comment: "This drops the error.",
}

describe("Finding", () => {
  it("decodes a single-line blocking finding and a multi-line nit", () => {
    assert.deepStrictEqual(Schema.decodeUnknownSync(Finding)(finding), finding)
    assert.isTrue(decodes(Finding, { ...finding, endLine: 9, severity: "nit" }))
  })

  it("rejects an unknown severity, a reversed range and non-positive lines", () => {
    for (const input of [
      { ...finding, severity: "major" },
      { ...finding, startLine: 5, endLine: 4 },
      { ...finding, startLine: 0, endLine: 1 },
      { ...finding, startLine: -2, endLine: -2 },
      { ...finding, startLine: 1.5, endLine: 2 },
    ]) {
      assert.isFalse(decodes(Finding, input), JSON.stringify(input))
    }
  })
})

describe("ThreadJudgement", () => {
  it("decodes each judgement, with an optional note and new anchor", () => {
    assert.isTrue(decodes(ThreadJudgement, { judgement: "addressed" }))
    assert.isTrue(decodes(ThreadJudgement, { judgement: "withdrawn", note: "I misread it." }))
    assert.isTrue(
      decodes(ThreadJudgement, {
        judgement: "still_applies",
        note: "Moved, still unhandled.",
        anchor: { startLine: 12, endLine: 14 },
      }),
    )
  })

  it("rejects an unknown judgement and an invalid anchor", () => {
    assert.isFalse(decodes(ThreadJudgement, { judgement: "resolved" }))
    assert.isFalse(
      decodes(ThreadJudgement, {
        judgement: "still_applies",
        anchor: { startLine: 4, endLine: 2 },
      }),
    )
    assert.isFalse(
      decodes(ThreadJudgement, {
        judgement: "still_applies",
        anchor: { startLine: 0, endLine: 0 },
      }),
    )
  })
})
