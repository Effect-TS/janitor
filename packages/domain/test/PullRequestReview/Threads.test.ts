import { assert, describe, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Option from "effect/Option"
import type { LineAnchor, TrustedDiff } from "@janitor/domain/PullRequestReview/Diff"
import type { Judgement, ThreadJudgement } from "@janitor/domain/PullRequestReview/Finding"
import { Fingerprint, type HeadMatch } from "@janitor/domain/PullRequestReview/Fingerprint"
import {
  checkDuplicate,
  type Clearing,
  type EarlierThread,
  judgeThread,
  planReply,
  type ThreadReply,
} from "@janitor/domain/PullRequestReview/Threads"

const at = (time: string) => DateTime.makeUnsafe(`2026-10-01T${time}:00Z`)

const thread = (overrides: Partial<EarlierThread> = {}): EarlierThread => ({
  id: "T1",
  path: "src/a.ts",
  anchor: { startLine: 10, endLine: 12 },
  severity: "blocking",
  fingerprint: Fingerprint.make("fp-original"),
  outdated: false,
  replies: [],
  janitor: { at: at("10:00"), judgement: "still_applies", outdated: false, resolved: false },
  ...overrides,
})

const diff: TrustedDiff = {
  files: [
    {
      _tag: "Anchorable",
      path: "src/a.ts",
      hunks: [{ startLine: 10, endLine: 12, lines: ["a", "b", "c"] }],
    },
  ],
}

const matches: HeadMatch = { _tag: "Matches", startLine: 10, endLine: 12 }

describe("checkDuplicate", () => {
  it("rejects repeats of open threads and of this run's findings, but not withdrawn threads", () => {
    const candidate = (
      startLine: number,
      endLine: number,
      fingerprint = "fp-new",
    ): LineAnchor & { readonly fingerprint: Fingerprint } => ({
      path: "src/a.ts",
      startLine,
      endLine,
      fingerprint: Fingerprint.make(fingerprint),
    })
    const resolved = thread({ resolvedBy: "maintainer" })
    const cases: ReadonlyArray<
      readonly [
        string,
        ReturnType<typeof candidate>,
        Parameters<typeof checkDuplicate>[1],
        Option.Option<string>,
      ]
    > = [
      [
        "overlaps an open thread",
        candidate(12, 14),
        { threads: [thread()], withdrawn: [], reported: [] },
        Option.some("already covered by thread T1, use updateThread"),
      ],
      [
        "next to an open thread",
        candidate(13, 14),
        { threads: [thread()], withdrawn: [], reported: [] },
        Option.none(),
      ],
      [
        "re-reported after withdrawing the thread in this run",
        candidate(10, 12),
        { threads: [thread()], withdrawn: ["T1"], reported: [] },
        Option.none(),
      ],
      [
        "the same finding twice in one run",
        candidate(11, 11),
        {
          threads: [],
          withdrawn: [],
          reported: [{ path: "src/a.ts", startLine: 11, endLine: 11 }],
        },
        Option.some("overlaps a finding already reported in this run"),
      ],
      [
        "the unchanged code of a thread a maintainer resolved",
        candidate(20, 22, "fp-original"),
        { threads: [resolved], withdrawn: [], reported: [] },
        Option.some("thread T1 was resolved by a maintainer and its code hasn't changed"),
      ],
      [
        "rewritten code where a maintainer resolved a thread",
        candidate(10, 12),
        { threads: [resolved], withdrawn: [], reported: [] },
        Option.none(),
      ],
    ]
    for (const [name, input, run, expected] of cases) {
      assert.deepStrictEqual(checkDuplicate(input, run), expected, name)
    }
  })
})

describe("judgeThread", () => {
  it("clears a blocking thread for dismissal or approval only on the paths EFF-1649 allows", () => {
    const later = at("11:00")
    const cases: ReadonlyArray<
      readonly [
        string,
        Partial<EarlierThread>,
        {
          readonly judgement?: ThreadJudgement
          readonly authorCanWrite?: boolean
        },
        Judgement,
        Clearing,
      ]
    > = [
      [
        "still applies",
        {},
        { judgement: { judgement: "still_applies" } },
        "still_applies",
        "standing",
      ],
      ["withdrawn", {}, { judgement: { judgement: "withdrawn" } }, "withdrawn", "approval"],
      [
        "addressed with the anchored lines unchanged",
        {},
        { judgement: { judgement: "addressed" } },
        "addressed",
        "approval",
      ],
      [
        "a maintainer replied",
        { replies: [{ by: "maintainer", at: later }] },
        { judgement: { judgement: "still_applies" } },
        "still_applies",
        "approval",
      ],
      [
        "a maintainer resolved it",
        { resolvedBy: "maintainer" },
        { judgement: { judgement: "still_applies" } },
        "still_applies",
        "approval",
      ],
      [
        "an author with write access replied",
        { replies: [{ by: "author", at: later }] },
        { judgement: { judgement: "still_applies" }, authorCanWrite: true },
        "still_applies",
        "dismissal",
      ],
      [
        "an author with write access resolved it",
        { resolvedBy: "author" },
        { judgement: { judgement: "still_applies" }, authorCanWrite: true },
        "still_applies",
        "dismissal",
      ],
      [
        "an author without write access resolved it",
        { resolvedBy: "author" },
        { judgement: { judgement: "still_applies" } },
        "still_applies",
        "standing",
      ],
      [
        "someone without write access replied",
        { replies: [{ by: "other", at: later }] },
        { judgement: { judgement: "still_applies" } },
        "still_applies",
        "standing",
      ],
      [
        "its path left the diff, without asking the agent",
        { path: "src/gone.ts" },
        {},
        "addressed",
        "approval",
      ],
    ]
    for (const [name, overrides, context, judgement, clearing] of cases) {
      const state = judgeThread(thread(overrides), {
        diff,
        authorCanWrite: false,
        ...context,
      })
      assert.deepStrictEqual(
        [state.judgement.judgement, state.clearing],
        [judgement, clearing],
        name,
      )
    }
  })
})

describe("planReply", () => {
  it("replies at most once, only after a human reply or a state change, and never resolves", () => {
    const cases: ReadonlyArray<
      readonly [
        string,
        Partial<EarlierThread>,
        ThreadJudgement,
        HeadMatch,
        Option.Option<ThreadReply>,
      ]
    > = [
      ["nothing changed", {}, { judgement: "still_applies" }, matches, Option.none()],
      [
        "a human replied after janitor",
        { replies: [{ by: "author", at: at("11:00") }] },
        { judgement: "still_applies", note: "Still unhandled." },
        matches,
        Option.some({ threadId: "T1", judgement: "still_applies", note: "Still unhandled." }),
      ],
      [
        "a human replied before janitor's last reply",
        { replies: [{ by: "author", at: at("09:00") }] },
        { judgement: "still_applies" },
        matches,
        Option.none(),
      ],
      [
        "an author without write access resolved it",
        { resolvedBy: "author" },
        { judgement: "still_applies" },
        matches,
        Option.some({ threadId: "T1", judgement: "still_applies" }),
      ],
      [
        "an outdated thread that still applies",
        { outdated: true },
        { judgement: "still_applies" },
        { _tag: "Matches", startLine: 30, endLine: 32 },
        Option.some({
          threadId: "T1",
          judgement: "still_applies",
          stillAppliesAt: "https://github.com/Effect-TS/janitor/blob/abc123/src/a.ts#L30-L32",
        }),
      ],
      [
        "an outdated thread janitor already said still applies",
        {
          outdated: true,
          janitor: { at: at("10:00"), judgement: "still_applies", outdated: true, resolved: false },
        },
        { judgement: "still_applies" },
        { _tag: "Matches", startLine: 30, endLine: 32 },
        Option.none(),
      ],
      [
        "a withdrawn blocker stays open with a reply",
        {},
        { judgement: "withdrawn", note: "I misread the guard." },
        matches,
        Option.some({ threadId: "T1", judgement: "withdrawn", note: "I misread the guard." }),
      ],
    ]
    for (const [name, overrides, judgement, headMatch, expected] of cases) {
      const earlier = thread(overrides)
      const state = judgeThread(earlier, { diff, judgement, authorCanWrite: false })
      assert.deepStrictEqual(
        planReply(earlier, state, {
          repository: "Effect-TS/janitor",
          headSha: "abc123",
          headMatch,
          authorCanWrite: false,
        }),
        expected,
        name,
      )
    }
  })
})
