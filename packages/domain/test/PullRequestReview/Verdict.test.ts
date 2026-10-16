import { assert, describe, it } from "@effect/vitest"
import type { Severity } from "@janitor/domain/PullRequestReview/Finding"
import type { Verdict } from "@janitor/domain/PullRequestReview/Run"
import type { Clearing, ThreadState } from "@janitor/domain/PullRequestReview/Threads"
import {
  allocateInline,
  approvalGates,
  type CheckRun,
  checkRun,
  type CheckRunInput,
  decideReview,
  type GateFailure,
  type ReviewInput,
} from "@janitor/domain/PullRequestReview/Verdict"

const blocking = { severity: "blocking" } as const
const nit = { severity: "nit" } as const

const threadState = (severity: Severity, clearing: Clearing, changed = false): ThreadState => ({
  threadId: "T1",
  severity,
  judgement: {
    judgement:
      clearing === "standing"
        ? "still_applies"
        : clearing === "approval"
          ? "addressed"
          : "withdrawn",
  },
  clearing,
  changed,
})

const manifest = (sections: object) => JSON.stringify({ name: "app", ...sections })

const input = (overrides: Partial<ReviewInput> = {}): ReviewInput => ({
  reviewedSha: "abc123",
  baseRefAtStart: "main",
  outcome: "completed",
  forced: false,
  authorCanWrite: false,
  pullRequest: { state: "open", draft: false, headSha: "abc123", baseRef: "main" },
  findings: [],
  threads: [],
  changedFiles: [{ filename: "src/a.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" }],
  manifests: [],
  sensitive: {
    globs: [".github/**", "AGENTS.md", ".agents/**"],
    lockfiles: ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"],
    manifests: ["package.json"],
  },
  earlierChangesRequested: false,
  approvedAtHead: false,
  ...overrides,
})

const touching = (...filenames: ReadonlyArray<string>): Partial<ReviewInput> => ({
  changedFiles: filenames.map((filename) => ({ filename, status: "modified" })),
})

describe("approvalGates", () => {
  it("reports every failed gate, and gates sensitive paths for outside authors only", () => {
    const dependencyChange = {
      ...touching("packages/domain/package.json"),
      manifests: [
        {
          path: "packages/domain/package.json",
          base: manifest({ dependencies: { effect: "4.0.0" } }),
          head: manifest({ dependencies: { effect: "4.0.0" }, peerDependencies: { react: "*" } }),
        },
      ],
    }
    const cases: ReadonlyArray<
      readonly [string, Partial<ReviewInput>, ReadonlyArray<GateFailure>]
    > = [
      ["every gate passes", {}, []],
      [
        "the head moved",
        { pullRequest: { state: "open", draft: false, headSha: "def456", baseRef: "main" } },
        [{ _tag: "HeadMoved" }],
      ],
      ["the run was steered", { outcome: "steered" }, [{ _tag: "Unfinished", outcome: "steered" }]],
      [
        "the run was interrupted",
        { outcome: "interrupted" },
        [{ _tag: "Unfinished", outcome: "interrupted" }],
      ],
      ["the run errored", { outcome: "errored" }, [{ _tag: "Unfinished", outcome: "errored" }]],
      ["a new blocking finding", { findings: [blocking] }, [{ _tag: "BlockingFindings" }]],
      [
        "a blocking thread cleared for dismissal only",
        { threads: [threadState("blocking", "dismissal")] },
        [{ _tag: "BlockingFindings" }],
      ],
      [
        "a blocking thread cleared for approval, and a standing nit",
        { findings: [nit], threads: [threadState("blocking", "approval")] },
        [],
      ],
      [
        "the pull request is closed",
        { pullRequest: { state: "closed", draft: false, headSha: "abc123", baseRef: "main" } },
        [{ _tag: "Closed" }],
      ],
      [
        "the pull request is a draft",
        { pullRequest: { state: "open", draft: true, headSha: "abc123", baseRef: "main" } },
        [{ _tag: "Draft" }],
      ],
      [
        "the base branch changed",
        { pullRequest: { state: "open", draft: false, headSha: "abc123", baseRef: "next" } },
        [{ _tag: "BaseChanged" }],
      ],
      ["a forced oversized review", { forced: true }, [{ _tag: "Forced" }]],
      [
        "several gates at once, in gate order",
        {
          forced: true,
          pullRequest: { state: "open", draft: true, headSha: "abc123", baseRef: "main" },
        },
        [{ _tag: "Draft" }, { _tag: "Forced" }],
      ],
      [
        "an outside author touches a config glob and a lockfile",
        touching(".github/workflows/ci.yml", "src/a.ts", "pnpm-lock.yaml"),
        [{ _tag: "SensitivePaths", paths: [".github/workflows/ci.yml", "pnpm-lock.yaml"] }],
      ],
      [
        "an outside author changes a dependency section of a nested manifest",
        dependencyChange,
        [{ _tag: "SensitivePaths", paths: ["packages/domain/package.json"] }],
      ],
      [
        "an outside author edits a manifest outside its dependency sections",
        {
          ...touching("package.json"),
          manifests: [
            {
              path: "package.json",
              base: manifest({ scripts: { test: "vp test" }, devDependencies: { vite: "8" } }),
              head: manifest({
                scripts: { test: "vp test --run" },
                devDependencies: { vite: "8" },
              }),
            },
          ],
        },
        [],
      ],
      [
        "a member touches sensitive paths",
        {
          ...dependencyChange,
          ...touching(".github/workflows/ci.yml", "pnpm-lock.yaml", "packages/domain/package.json"),
          authorCanWrite: true,
        },
        [],
      ],
    ]
    for (const [name, overrides, expected] of cases) {
      assert.deepStrictEqual(approvalGates(input(overrides)), expected, name)
    }
  })
})

describe("decideReview", () => {
  const approvalCases: ReadonlyArray<readonly [string, Partial<ReviewInput>, Verdict | null]> = [
    ["a quiet re-run at an approved head", { approvedAtHead: true }, null],
    [
      "a quiet re-run with an unchanged standing nit at an approved head",
      { approvedAtHead: true, threads: [threadState("nit", "standing")] },
      null,
    ],
    ["a first approval", { approvedAtHead: false }, "approve"],
    [
      "a quiet run at a new head without an approval there",
      {
        approvedAtHead: false,
        reviewedSha: "def456",
        pullRequest: { state: "open", draft: false, headSha: "def456", baseRef: "main" },
      },
      "approve",
    ],
    ["a new nit at an approved head", { approvedAtHead: true, findings: [nit] }, "approve"],
    [
      "a changed nit thread at an approved head",
      { approvedAtHead: true, threads: [threadState("nit", "standing", true)] },
      "approve",
    ],
    [
      "a new blocker at an approved head",
      { approvedAtHead: true, findings: [blocking] },
      "request_changes",
    ],
  ]

  it.each(approvalCases)("respects approval history for %s", (_, overrides, event) => {
    const decision = decideReview(input(overrides))
    assert.deepStrictEqual(
      { event: decision.event, dismissEarlier: decision.dismissEarlier },
      {
        event,
        dismissEarlier: false,
      },
    )
  })

  it("maps findings, gates and changes to a review event and dismissal", () => {
    const draft = {
      pullRequest: { state: "open", draft: true, headSha: "abc123", baseRef: "main" },
    } as const
    const cases: ReadonlyArray<
      readonly [
        string,
        Partial<ReviewInput>,
        { readonly event: Verdict | null; readonly dismissEarlier: boolean },
      ]
    > = [
      [
        "a new blocking finding",
        { findings: [blocking, nit] },
        { event: "request_changes", dismissEarlier: false },
      ],
      [
        "only new nits, gates pass",
        { findings: [nit] },
        { event: "approve", dismissEarlier: false },
      ],
      ["no findings, gates pass", {}, { event: "approve", dismissEarlier: false }],
      [
        "only new nits, a gate fails",
        { findings: [nit], ...draft },
        { event: "comment", dismissEarlier: false },
      ],
      ["no findings and a gate fails", draft, { event: null, dismissEarlier: false }],
      [
        "an earlier blocker withdrawn, not cleared for approval",
        { threads: [threadState("blocking", "dismissal", true)], earlierChangesRequested: true },
        { event: null, dismissEarlier: true },
      ],
      [
        "an earlier blocker cleared for approval",
        { threads: [threadState("blocking", "approval", true)], earlierChangesRequested: true },
        { event: "approve", dismissEarlier: true },
      ],
      [
        "a quiet run with a standing blocker",
        { threads: [threadState("blocking", "standing")], earlierChangesRequested: true },
        { event: null, dismissEarlier: false },
      ],
      [
        "a quiet run with a standing nit and a failed gate",
        { threads: [threadState("nit", "standing")], ...draft },
        { event: null, dismissEarlier: false },
      ],
      [
        "a standing blocker whose thread changed",
        { threads: [threadState("blocking", "standing", true)], earlierChangesRequested: true },
        { event: "request_changes", dismissEarlier: false },
      ],
      [
        "a steered run with nits",
        { outcome: "steered", findings: [nit] },
        { event: "comment", dismissEarlier: false },
      ],
      [
        "a partial review with a blocking finding",
        { outcome: "interrupted", findings: [blocking] },
        { event: "request_changes", dismissEarlier: false },
      ],
      [
        "a partial review with only nits",
        { outcome: "interrupted", findings: [nit] },
        { event: "comment", dismissEarlier: false },
      ],
      [
        "an errored run with no findings",
        { outcome: "errored" },
        { event: null, dismissEarlier: false },
      ],
    ]
    for (const [name, overrides, expected] of cases) {
      const { event, dismissEarlier } = decideReview(input(overrides))
      assert.deepStrictEqual({ event, dismissEarlier }, expected, name)
    }
  })
})

describe("checkRun", () => {
  it("concludes from the run state and the findings standing at the dismissal level", () => {
    const ended = (
      overrides: Partial<Extract<CheckRunInput, { _tag: "Ended" }>>,
    ): CheckRunInput => ({
      _tag: "Ended",
      outcome: "completed",
      findings: [],
      threads: [],
      ...overrides,
    })
    const cases: ReadonlyArray<readonly [string, CheckRunInput, CheckRun]> = [
      ["running", { _tag: "Running" }, { status: "in_progress" }],
      [
        "cancelled or superseded",
        { _tag: "Cancelled" },
        { status: "completed", conclusion: "cancelled" },
      ],
      [
        "skipped as oversized",
        { _tag: "Skipped", reason: "oversized" },
        { status: "completed", conclusion: "neutral", reason: "oversized" },
      ],
      [
        "a new blocking finding",
        ended({ findings: [blocking] }),
        { status: "completed", conclusion: "failure" },
      ],
      [
        "a blocking thread cleared for dismissal",
        ended({ threads: [threadState("blocking", "dismissal")] }),
        { status: "completed", conclusion: "success" },
      ],
      ["only nits", ended({ findings: [nit] }), { status: "completed", conclusion: "success" }],
      [
        "a steered run",
        ended({ outcome: "steered" }),
        { status: "completed", conclusion: "success" },
      ],
      [
        "at the deadline",
        ended({ outcome: "interrupted", findings: [blocking] }),
        { status: "completed", conclusion: "neutral", reason: "interrupted" },
      ],
      [
        "a provider failure",
        ended({ outcome: "errored" }),
        { status: "completed", conclusion: "neutral", reason: "errored" },
      ],
    ]
    for (const [name, run, expected] of cases) {
      assert.deepStrictEqual(checkRun(run), expected, name)
    }
  })
})

describe("allocateInline", () => {
  it("gives blocking findings the inline slots first and lists the rest in the body", () => {
    const finding = (id: string, severity: Severity, anchored = true) => ({
      id,
      severity,
      anchored,
    })
    const findings = [
      finding("A", "nit"),
      finding("B", "blocking"),
      finding("C", "blocking", false),
      finding("D", "nit"),
      finding("E", "blocking"),
    ]
    const cases: ReadonlyArray<readonly [number, ReadonlyArray<string>, ReadonlyArray<string>]> = [
      [1, ["B"], ["A", "C", "D", "E"]],
      [3, ["B", "E", "A"], ["C", "D"]],
    ]
    for (const [limit, inline, body] of cases) {
      const allocation = allocateInline(findings, limit)
      assert.deepStrictEqual(
        { inline: allocation.inline.map((f) => f.id), body: allocation.body.map((f) => f.id) },
        { inline, body },
        `limit ${limit}`,
      )
    }
  })
})
