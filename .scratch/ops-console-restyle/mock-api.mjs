// Stand-in for the Janitor API on http://localhost:8787 so the web app
// renders every screen without Cloudflare, Postgres, or GitHub.
// Run: node .scratch/ops-console-restyle/mock-api.mjs
// Then: JANITOR_API_ORIGIN=http://localhost:8787 vp dev (from apps/web).
import { createServer } from "node:http"
import { createHash } from "node:crypto"

const PORT = Number(process.env.MOCK_PORT ?? 8787)
const now = "2026-09-13T10:00:00.000Z"

const repositories = [
  {
    repositoryId: "701",
    owner: "effect",
    repo: "effect",
    enabled: true,
    syncEnabled: true,
    ruleCount: 4,
    policyCount: 3,
    access: "accessible",
    configuredRevision: 7,
    activeRevision: 7,
  },
  {
    repositoryId: "702",
    owner: "effect",
    repo: "effect-smol",
    enabled: true,
    ruleCount: 1,
    policyCount: 1,
    access: "accessible",
    configuredRevision: 3,
    activeRevision: 2,
  },
  {
    repositoryId: "801",
    owner: "acme",
    repo: "widgets",
    enabled: false,
    syncEnabled: false,
    ruleCount: 0,
    policyCount: 0,
    access: "suspect",
    configuredRevision: null,
    activeRevision: null,
  },
]

const textOps = ["equals", "notEquals", "contains", "matchesGlob", "in", "isEmpty", "notEmpty"]
const catalog = [
  {
    name: "title",
    type: "Text",
    kinds: ["issue", "pull_request"],
    track: "entities",
    description: "Title",
    operators: textOps,
    fields: [],
  },
  {
    name: "body",
    type: "Text",
    kinds: ["issue", "pull_request"],
    track: "entities",
    description: "Body",
    operators: textOps,
    fields: [],
  },
  {
    name: "author",
    type: "Text",
    kinds: ["issue", "pull_request"],
    track: "entities",
    description: "Author login",
    operators: textOps,
    fields: [],
  },
  {
    name: "state",
    type: "Text",
    kinds: ["issue", "pull_request"],
    track: "entities",
    description: "open or closed",
    operators: textOps,
    fields: [],
  },
  {
    name: "labels",
    type: "LabelSet",
    kinds: ["issue", "pull_request"],
    track: "labels",
    description: "Labels currently applied",
    operators: ["has", "isEmpty", "notEmpty"],
    fields: [],
  },
  {
    name: "draft",
    type: "Flag",
    kinds: ["pull_request"],
    track: "pull_requests",
    description: "Whether the pull request is a draft",
    operators: ["is"],
    fields: [],
  },
  {
    name: "baseRef",
    type: "Text",
    kinds: ["pull_request"],
    track: "pull_requests",
    description: "Base branch name",
    operators: textOps,
    fields: [],
  },
  {
    name: "changedFiles",
    type: "Collection",
    kinds: ["pull_request"],
    track: "changed_files",
    description: "Files changed",
    operators: ["some", "every", "none"],
    fields: [
      { name: "path", type: "Text", operators: textOps },
      { name: "status", type: "Text", operators: textOps },
    ],
  },
]

const policies = [
  {
    policyId: "p1",
    repositoryId: "701",
    name: "Base is main",
    target: "pull_request",
    description: "Pull requests that target the default branch.",
    publishedVersionId: "v1",
    publishedRevision: 6,
    draftDiffers: false,
    publishedEvaluator: "Conditions",
    version: 2,
    createdAt: "2026-09-01T09:00:00.000Z",
    updatedAt: "2026-09-03T14:00:00.000Z",
  },
  {
    policyId: "p2",
    repositoryId: "701",
    name: "Needs triage",
    target: "issue",
    description: "Issues with no labels yet.",
    publishedVersionId: null,
    publishedRevision: null,
    draftDiffers: true,
    version: 3,
    createdAt: "2026-09-02T10:30:00.000Z",
    updatedAt: "2026-09-09T08:15:00.000Z",
  },
  {
    policyId: "p3",
    repositoryId: "701",
    name: "Looks like a bug report",
    target: "issue",
    description: "Classifier over the title and body.",
    publishedVersionId: "v3",
    publishedRevision: 7,
    draftDiffers: false,
    publishedEvaluator: "Classifier",
    version: 1,
    createdAt: "2026-09-05T11:00:00.000Z",
    updatedAt: "2026-09-05T11:00:00.000Z",
  },
]

const rules = [
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
    createdAt: "2026-09-01T09:05:00.000Z",
    updatedAt: "2026-09-03T14:00:00.000Z",
  },
  {
    id: "r2",
    repositoryId: "701",
    labelId: "12",
    policyId: "p2",
    onMatch: "ensure-present",
    onNoMatch: "no-action",
    group: "triage",
    priority: 3,
    enabled: true,
    labelStatus: "valid",
    version: 2,
    createdAt: "2026-09-02T10:35:00.000Z",
    updatedAt: "2026-09-09T08:20:00.000Z",
  },
  {
    id: "r3",
    repositoryId: "701",
    labelId: "13",
    policyId: "p3",
    ai: {
      gatePolicyId: "p2",
      target: "issue",
      prompt: "Does {{fact:title}} together with {{fact:body}} describe a reproducible defect?",
      minimumConfidence: 0.8,
    },
    onMatch: "ensure-present",
    onNoMatch: "no-action",
    group: "triage",
    priority: 7,
    enabled: true,
    labelStatus: "valid",
    version: 1,
    createdAt: "2026-09-05T11:05:00.000Z",
    updatedAt: "2026-09-05T11:05:00.000Z",
  },
  {
    id: "r4",
    repositoryId: "701",
    labelId: "14",
    policyId: "p1",
    onMatch: "ensure-absent",
    onNoMatch: "no-action",
    group: null,
    priority: 12,
    enabled: false,
    labelStatus: "missing",
    version: 4,
    createdAt: "2026-08-20T12:00:00.000Z",
    updatedAt: "2026-09-06T16:45:00.000Z",
  },
]

const labels = [
  { labelId: "11", name: "bug", color: "d73a4a", availability: "available" },
  { labelId: "12", name: "needs-triage", color: "fbca04", availability: "available" },
  { labelId: "13", name: "ai-suggested", color: "0e8a16", availability: "available" },
  { labelId: "14", name: "stale", color: null, availability: "unavailable" },
]

const configuration = (repositoryId) =>
  repositoryId === "701"
    ? {
        repositoryId,
        configuredRevision: 7,
        activeRevision: 7,
        pendingTracks: [],
        policies,
        rules,
        labels,
        labelFreshness: "verified",
      }
    : {
        repositoryId,
        configuredRevision: 3,
        activeRevision: 2,
        pendingTracks: ["labels"],
        policies: policies.slice(0, 1).map((p) => ({ ...p, repositoryId })),
        rules: rules.slice(0, 1).map((r) => ({ ...r, repositoryId })),
        labels: labels.slice(0, 1),
        labelFreshness: "syncing",
      }

const testItems = [
  {
    number: 7,
    kind: "issue",
    title: "Crash on save",
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
    title: "Fix interruption on save",
    authorLogin: "octocat",
    baseRef: "main",
    draft: false,
    labels: ["11"],
    evaluation: null,
    plan: null,
  },
  {
    number: 6,
    kind: "pull_request",
    title: "Add a feature",
    authorLogin: "gcanti",
    baseRef: "next",
    draft: true,
    labels: [],
    evaluation: null,
    plan: null,
  },
]

const conditionsSource = {
  target: "pull_request",
  appliesWhen: { fact: "draft", operator: "is", value: false },
  matchesWhen: {
    all: [
      { fact: "baseRef", operator: "equals", value: "main" },
      { not: { fact: "title", operator: "contains", value: "WIP" } },
    ],
  },
}
const manifest = {
  facts: ["baseRef", "draft", "title"],
  tracks: ["entities", "pull_requests"],
  references: [],
  nodeCount: 4,
  expandedNodeCount: 4,
}
const policyDetail = (policyId) => {
  const policy = policies.find((p) => p.policyId === policyId) ?? policies[0]
  if (policy.policyId === "p3")
    return {
      policy,
      draft: {
        target: "issue",
        classify: {
          prompt: "Does this issue describe a reproducible defect?",
          evidence: ["title", "body"],
          minimumConfidence: 0.8,
        },
      },
      draftDiffers: false,
      published: {
        versionId: "v3",
        policyId: "p3",
        revision: 7,
        contentHash: "c".repeat(64),
        program: {
          target: "issue",
          appliesWhen: null,
          evaluator: {
            _tag: "Classifier",
            prompt: "Does this issue describe a reproducible defect?",
            evidence: ["title", "body"],
            minimumConfidence: 0.8,
          },
        },
        manifest: {
          facts: ["body", "title"],
          tracks: ["entities"],
          references: [],
          nodeCount: 1,
          expandedNodeCount: 1,
        },
        createdAt: "2026-09-05T11:00:00.000Z",
      },
    }
  if (policy.policyId === "p2")
    return {
      policy,
      draft: { target: "issue", matchesWhen: { fact: "labels", operator: "isEmpty" } },
      draftDiffers: true,
      published: null,
    }
  return {
    policy,
    draft: conditionsSource,
    draftDiffers: false,
    publishedSource: conditionsSource,
    published: {
      versionId: "v1",
      policyId: "p1",
      revision: 6,
      contentHash: "a".repeat(64),
      program: {
        target: "pull_request",
        appliesWhen: { _tag: "Fact", fact: "draft", operator: "is", value: false },
        evaluator: {
          _tag: "Conditions",
          matchesWhen: {
            _tag: "All",
            conditions: [
              { _tag: "Fact", fact: "baseRef", operator: "equals", value: "main" },
              {
                _tag: "Not",
                condition: { _tag: "Fact", fact: "title", operator: "contains", value: "WIP" },
              },
            ],
          },
        },
      },
      manifest,
      createdAt: "2026-09-03T14:00:00.000Z",
    },
  }
}

const evaluated = {
  _tag: "Evaluated",
  entities: [
    {
      ...testItems[1],
      evaluation: {
        outcome: "match",
        reason: "baseRef equals main",
        trace: [
          {
            location: { root: "matchesWhen", path: [{ _tag: "Child", index: 0 }] },
            outcome: "match",
            reason: "baseRef equals main",
          },
          {
            location: { root: "matchesWhen", path: [{ _tag: "Child", index: 1 }, { _tag: "Not" }] },
            outcome: "no-match",
            reason: "title does not contain WIP",
          },
        ],
      },
      plan: {
        rules: [
          { ruleId: "r1", outcome: "match", selected: true, requestedAction: "ensure-present" },
        ],
        actions: [{ labelId: "11", action: "add", ruleId: "r1" }],
      },
    },
    {
      ...testItems[2],
      evaluation: { outcome: "no-match", reason: "baseRef equals next", trace: [] },
      plan: {
        rules: [
          { ruleId: "r1", outcome: "no-match", selected: false, requestedAction: "ensure-absent" },
        ],
        actions: [],
      },
    },
  ],
}

const aiJob = (testId, status) => ({
  testId,
  status,
  message: status === "queued" ? "Queued behind 1 test" : null,
  response:
    status === "done"
      ? {
          _tag: "Evaluated",
          entities: [
            {
              ...testItems[0],
              evaluation: {
                outcome: "match",
                reason: "The issue describes a reproducible defect with steps.",
                confidence: 0.91,
                cached: false,
                trace: [],
                inputReport: {
                  version: 1,
                  budgetBytes: 32768,
                  originalBytes: 41000,
                  suppliedBytes: 32768,
                  status: "shortened",
                  facts: [
                    { name: "title", originalBytes: 30, suppliedBytes: 30, omission: null },
                    {
                      name: "body",
                      originalBytes: 40970,
                      suppliedBytes: 32738,
                      omission: { start: 32738, end: 40970, unit: "characters" },
                    },
                  ],
                },
              },
              plan: {
                rules: [
                  {
                    ruleId: "r3",
                    outcome: "match",
                    selected: true,
                    requestedAction: "ensure-present",
                  },
                ],
                actions: [{ labelId: "13", action: "add", ruleId: "r3" }],
              },
            },
          ],
        }
      : null,
})
const jobs = new Map()

const activity = {
  entries: [
    {
      id: "a1",
      number: 42,
      title: "Fix interruption on save",
      kind: "pull_request",
      createdAt: "2026-09-12T09:00:00.000Z",
      outcome: "evaluated",
      detail: "1 change applied",
      revision: 7,
      plan: {
        rules: [
          { ruleId: "r1", outcome: "match", selected: true, requestedAction: "ensure-present" },
        ],
        actions: [{ labelId: "11", action: "add", ruleId: "r1" }],
      },
      actions: [
        {
          labelId: "11",
          name: "bug",
          color: "d73a4a",
          ruleId: "r1",
          action: "add",
          status: "applied",
          detail: null,
        },
      ],
      evaluations: [{ ruleId: "r1", outcome: "match", reason: "baseRef equals main" }],
    },
    {
      id: "a2",
      number: 42,
      title: "Fix interruption on save",
      kind: "pull_request",
      createdAt: "2026-09-12T08:58:00.000Z",
      outcome: "superseded",
      detail: "A newer snapshot arrived before this run finished",
      revision: 7,
      plan: null,
      actions: [],
      evaluations: [],
    },
    {
      id: "a3",
      number: 43,
      title: "Crash on save",
      kind: "issue",
      createdAt: "2026-09-12T08:40:00.000Z",
      outcome: "evaluated",
      detail: "1 change failed",
      revision: 7,
      plan: {
        rules: [
          { ruleId: "r3", outcome: "match", selected: true, requestedAction: "ensure-present" },
          { ruleId: "r2", outcome: "no-match", selected: false, requestedAction: "no-action" },
        ],
        actions: [{ labelId: "13", action: "add", ruleId: "r3" }],
      },
      actions: [
        {
          labelId: "13",
          name: "ai-suggested",
          color: "0e8a16",
          ruleId: "r3",
          action: "add",
          status: "failed",
          detail: "GitHub rejected the label update (403)",
        },
        {
          labelId: "14",
          name: "stale",
          color: null,
          ruleId: "r4",
          action: "remove",
          status: "applied",
          detail: null,
        },
      ],
      evaluations: [
        {
          ruleId: "r3",
          outcome: "match",
          reason: "The issue reports a crash with reproduction steps (confidence 0.91).",
        },
        { ruleId: "r2", outcome: "no-match", reason: "labels is not empty" },
      ],
    },
    {
      id: "a4",
      number: 44,
      title: "Update the README",
      kind: "pull_request",
      createdAt: "2026-09-12T08:05:00.000Z",
      outcome: "not-qualified",
      detail: "No rule applies to this pull request",
      revision: 7,
      plan: null,
      actions: [],
      evaluations: [
        { ruleId: "r1", outcome: "unknown", reason: "baseRef was not in the snapshot" },
      ],
    },
    {
      id: "a5",
      number: 45,
      title: "Flaky integration test",
      kind: "issue",
      createdAt: "2026-09-12T07:30:00.000Z",
      outcome: "failed",
      detail: "The snapshot could not be read",
      revision: 6,
      plan: null,
      actions: [],
      evaluations: [
        { ruleId: "r3", outcome: "failed", reason: "The model provider was unavailable" },
      ],
    },
    {
      id: "a6",
      number: 46,
      title: null,
      kind: null,
      createdAt: "2026-09-11T19:12:00.000Z",
      outcome: "evaluated",
      detail: null,
      revision: 6,
      plan: {
        rules: [{ ruleId: "r2", outcome: "match", selected: true }],
        actions: [{ labelId: "12", action: "add", ruleId: "r2" }],
      },
      actions: [
        {
          labelId: "12",
          name: "needs-triage",
          color: "fbca04",
          ruleId: "r2",
          action: "add",
          status: "planned",
          detail: null,
        },
      ],
    },
  ],
  cursor: null,
}

const sessions = [
  {
    sessionId: "ses-working",
    title: "Fix the flaky test",
    repository: { repositoryId: "701", owner: "effect", repo: "effect" },
    homeThread: { platform: "slack", url: "https://app.slack.com/archives/C1/p1" },
    pullRequests: [{ number: 17, url: "https://github.com/effect/effect/pull/17" }],
    execution: "working",
    reason: "input pending",
    activityAt: now,
    usage: { input: 12000, output: 500 },
    deliveryWarning: null,
    freshness: { readAt: now, error: null },
  },
  {
    sessionId: "ses-idle",
    title: "Review the release notes",
    repository: { repositoryId: "702", owner: "effect", repo: "effect-smol" },
    homeThread: null,
    pullRequests: [],
    execution: "idle",
    reason: null,
    activityAt: "2026-09-13T08:12:00.000Z",
    usage: { input: 3400, output: 220 },
    deliveryWarning: null,
    freshness: { readAt: "2026-09-13T09:58:00.000Z", error: null },
  },
  {
    sessionId: "ses-blocked",
    title: "Slack conversation",
    repository: null,
    homeThread: { platform: "slack", url: "https://app.slack.com/archives/C2/p2" },
    pullRequests: [],
    execution: "blocked",
    reason: "Waiting for repository selection",
    activityAt: "2026-09-12T21:40:00.000Z",
    usage: null,
    deliveryWarning: "Janitor is no longer in the channel",
    freshness: { readAt: null, error: "Runner did not answer the last read" },
  },
]
const sessionDetail = (sessionId) => ({
  ...(sessions.find((s) => s.sessionId === sessionId) ?? {
    ...sessions[0],
    sessionId,
    execution: "failed",
    reason: "provider down",
    deliveryWarning: "Janitor is no longer in the channel",
  }),
  pendingInputs: 1,
  acceptedInputs: 3,
  lastInputAt: "2026-09-13T09:58:00.000Z",
  latestError: sessionId === "ses-blocked" ? "Runner did not answer the last read" : null,
  pendingDelivery:
    sessionId === "ses-blocked"
      ? [{ platform: "slack", state: "pending", error: "not_in_channel" }]
      : [],
  recovery: [
    {
      platform: "github",
      completedAt: "2026-09-13T09:30:00.000Z",
      overdue: sessionId === "ses-blocked",
      incomplete: sessionId === "ses-blocked",
      hydrating: sessionId === "ses-blocked" ? 2 : 0,
      warning: sessionId === "ses-blocked" ? "GitHub asked us to slow down" : null,
      gap: "Only retained GitHub deliveries can be recovered",
    },
    {
      platform: "slack",
      completedAt: "2026-09-13T09:55:00.000Z",
      overdue: false,
      incomplete: false,
      hydrating: 0,
      warning: null,
      gap: "Deleted uncaptured text cannot be recovered",
    },
  ],
})

const teammate = {
  teammateId: "t-me",
  issuer: "https://team.cloudflareaccess.test",
  subject: "me",
  email: "maxwell.brown@example.com",
  role: "admin",
  status: "active",
  createdAt: "2026-08-01T00:00:00.000Z",
  removedAt: null,
}
const account = {
  teammate,
  links: [
    {
      linkId: "l-slack",
      platform: "slack",
      workspaceId: "T1",
      accountId: "U1",
      displayName: "Max",
      status: "active",
      linkedAt: "2026-08-02T00:00:00.000Z",
      endedAt: null,
    },
    {
      linkId: "l-github",
      platform: "github",
      workspaceId: "github.com",
      accountId: "1024",
      displayName: "maxwellbrown",
      status: "active",
      linkedAt: "2026-08-02T00:05:00.000Z",
      endedAt: null,
    },
  ],
  linking: { slack: true, github: true },
  team: [
    {
      ...teammate,
      links: [
        {
          linkId: "l-slack",
          platform: "slack",
          workspaceId: "T1",
          accountId: "U1",
          displayName: "Max",
          status: "active",
          linkedAt: "2026-08-02T00:00:00.000Z",
          endedAt: null,
        },
      ],
    },
    {
      teammateId: "t-other",
      issuer: "https://team.cloudflareaccess.test",
      subject: "other",
      email: "dana@example.com",
      role: "member",
      status: "active",
      createdAt: "2026-08-04T00:00:00.000Z",
      removedAt: null,
      links: [
        {
          linkId: "l-slack-2",
          platform: "slack",
          workspaceId: "T1",
          accountId: "U2",
          displayName: "Dana",
          status: "active",
          linkedAt: "2026-08-04T09:00:00.000Z",
          endedAt: null,
        },
      ],
    },
    {
      teammateId: "t-gone",
      issuer: "https://team.cloudflareaccess.test",
      subject: "gone",
      email: null,
      role: "member",
      status: "removed",
      createdAt: "2026-07-10T00:00:00.000Z",
      removedAt: "2026-09-01T00:00:00.000Z",
      links: [
        {
          linkId: "l-slack-3",
          platform: "slack",
          workspaceId: "T1",
          accountId: "U3",
          displayName: "Sam",
          status: "disabled",
          linkedAt: "2026-07-10T00:00:00.000Z",
          endedAt: "2026-09-01T00:00:00.000Z",
        },
      ],
    },
  ],
}

const inventory = {
  repositories: [
    {
      repositoryId: "701",
      installationId: "77",
      owner: "effect",
      repo: "effect",
      isPrivate: false,
      connected: true,
      enabled: true,
      reconnect: false,
      access: "accessible",
      installationStatus: "active",
      policyCount: 3,
      ruleCount: 4,
      sessionCount: 1,
      pendingCleanups: 0,
      syncState: "ready",
    },
    {
      repositoryId: "702",
      installationId: "77",
      owner: "effect",
      repo: "effect-smol",
      isPrivate: true,
      connected: true,
      enabled: false,
      reconnect: false,
      access: "accessible",
      installationStatus: "active",
      policyCount: 1,
      ruleCount: 1,
      sessionCount: 0,
      pendingCleanups: 1,
      syncState: "failed",
      syncError: "GitHub timeout",
    },
    {
      repositoryId: "801",
      installationId: "77",
      owner: "acme",
      repo: "widgets",
      isPrivate: null,
      connected: false,
      enabled: false,
      reconnect: false,
      access: "suspect",
      accessError: "The app cannot read this repository",
      installationStatus: "active",
      policyCount: 0,
      ruleCount: 0,
      sessionCount: 0,
      pendingCleanups: 0,
      syncState: "idle",
    },
  ],
}

const syncSummary = (state) =>
  state === "syncing"
    ? {
        state,
        lastVerifiedAt: "2026-09-13T09:55:00.000Z",
        pendingTargets: 3,
        blockedTargets: 0,
        failedTargets: 1,
        queuedTargets: 1,
        runningTargets: 2,
        retryingTargets: 0,
        stalledTargets: 0,
        appliedItems: 100,
      }
    : {
        state: "idle",
        lastVerifiedAt: "2026-09-13T09:55:00.000Z",
        pendingTargets: 0,
        blockedTargets: 0,
        failedTargets: 0,
      }
let syncState = process.env.MOCK_SYNC ?? "idle"

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(body === undefined ? "" : JSON.stringify(body))
}

const readBody = (req) =>
  new Promise((resolve) => {
    let data = ""
    req.on("data", (chunk) => (data += chunk))
    req.on("end", () => resolve(data))
  })

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost")
  const path = url.pathname.replace(/^\/api\/v1/, "")
  const method = req.method ?? "GET"
  const body = await readBody(req)
  const m = (pattern) => path.match(pattern)
  let x
  if (method === "GET" && path === "/repositories") return json(res, 200, repositories)
  if (method === "GET" && path === "/labeling/catalog") return json(res, 200, catalog)
  if (method === "GET" && path === "/sync") return json(res, 200, syncSummary(syncState))
  if (method === "POST" && (path === "/sync" || m(/^\/repositories\/[^/]+\/sync$/))) {
    syncState = "syncing"
    setTimeout(() => (syncState = "idle"), 8000)
    return json(res, 202, syncSummary("syncing"))
  }
  if (method === "GET" && (x = m(/^\/repositories\/([^/]+)\/configuration$/)))
    return json(res, 200, configuration(x[1]))
  if (method === "GET" && m(/^\/repositories\/[^/]+\/test\/items$/))
    return json(res, 200, testItems)
  if (method === "GET" && (x = m(/^\/repositories\/([^/]+)\/ai-consent$/)))
    return json(res, 200, {
      repositoryId: x[1],
      state: "enabled",
      provider: "openai",
      model: "gpt-5.6-luna",
      activeLeases: 2,
      updatedAt: "2026-09-10T12:00:00.000Z",
    })
  if (method === "PUT" && (x = m(/^\/repositories\/([^/]+)\/ai-consent$/)))
    return json(res, 200, {
      repositoryId: x[1],
      state: JSON.parse(body || "{}").enabled ? "enabled" : "draining",
      provider: "openai",
      model: "gpt-5.6-luna",
      activeLeases: 1,
      updatedAt: now,
    })
  if (method === "GET" && (x = m(/^\/repositories\/[^/]+\/policies\/([^/]+)$/)))
    return json(res, 200, policyDetail(x[1]))
  if (method === "POST" && m(/^\/repositories\/[^/]+\/policies\/validate$/))
    return json(res, 200, { _tag: "Valid", manifest })
  if (method === "POST" && m(/^\/repositories\/[^/]+\/policies$/))
    return json(res, 201, policyDetail("p2"))
  if (method === "PUT" && (x = m(/^\/repositories\/[^/]+\/policies\/([^/]+)$/)))
    return json(res, 200, policyDetail(x[1]))
  if (method === "POST" && (x = m(/^\/repositories\/[^/]+\/policies\/([^/]+)\/publish$/)))
    return json(res, 200, policyDetail(x[1]))
  if (method === "DELETE" && m(/^\/repositories\/[^/]+\/policies\/[^/]+$/)) return json(res, 204)
  if (method === "POST" && m(/^\/repositories\/[^/]+\/rules$/)) return json(res, 201, rules[0])
  if (method === "PATCH" && (x = m(/^\/repositories\/[^/]+\/rules\/([^/]+)$/))) {
    const rule = rules.find((r) => r.id === x[1]) ?? rules[0]
    const patch = JSON.parse(body || "{}")
    return json(res, 200, {
      ...rule,
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      version: rule.version + 1,
    })
  }
  if (method === "DELETE" && m(/^\/repositories\/[^/]+\/rules\/[^/]+$/)) return json(res, 204)
  if (method === "POST" && m(/^\/repositories\/[^/]+\/rules\/reorder$/))
    return json(res, 200, rules)
  if (method === "POST" && m(/^\/repositories\/[^/]+\/test$/)) return json(res, 200, evaluated)
  if (method === "POST" && m(/^\/repositories\/[^/]+\/rule-tests$/)) {
    const testId = `t-${Date.now()}`
    jobs.set(testId, Date.now())
    return json(res, 202, aiJob(testId, "queued"))
  }
  if (method === "GET" && (x = m(/^\/repositories\/[^/]+\/rule-tests\/([^/]+)\/input$/)))
    return json(res, 200, {
      system: "You answer yes or no about a GitHub issue, with a confidence between 0 and 1.",
      text: "Question: Does this issue describe a reproducible defect?\n\ntitle: Crash on save\nbody: Steps: 1. open 2. save 3. crash",
      facts: [
        { name: "title", json: '"Crash on save"' },
        { name: "body", json: '"Steps: 1. open 2. save 3. crash"' },
      ],
    })
  if (method === "GET" && (x = m(/^\/repositories\/[^/]+\/rule-tests\/([^/]+)$/))) {
    const started = jobs.get(x[1]) ?? Date.now()
    const age = Date.now() - started
    return json(res, 200, aiJob(x[1], age < 1500 ? "queued" : age < 3000 ? "running" : "done"))
  }
  if (method === "GET" && m(/^\/repositories\/[^/]+\/activity$/)) {
    const search = url.searchParams.get("search") ?? ""
    const entries = activity.entries.filter(
      (e) => search === "" || (e.title ?? "").toLowerCase().includes(search.toLowerCase()),
    )
    return json(res, 200, { entries, cursor: null })
  }
  if (method === "GET" && (m(/^\/repositories\/[^/]+\/live$/) || path === "/sessions/live"))
    return json(res, 204)
  if (method === "GET" && path === "/sessions") return json(res, 200, { sessions, cursor: null })
  if (method === "GET" && (x = m(/^\/sessions\/([^/]+)$/)))
    return json(res, 200, sessionDetail(x[1]))
  if (method === "GET" && path === "/account") return json(res, 200, account)
  if (method === "POST" && m(/^\/account\/links\/[^/]+\/start$/))
    return json(res, 200, { url: "https://example.com/oauth" })
  if (method === "DELETE" && m(/^\/account\/links\//)) return json(res, 204)
  if (m(/^\/team\//)) return json(res, 204)
  if (method === "GET" && path === "/repository-connections/available")
    return json(res, 200, inventory)
  if (m(/^\/repository-connections\/github$/))
    return json(res, 200, { url: "https://github.com/apps/janitor/installations/new" })
  if (m(/^\/repository-connections\//)) return json(res, 204)
  if (m(/^\/repositories\/[^/]+\/connection$/)) return json(res, 204)
  return json(res, 404, { message: `No mock for ${method} ${path}` })
})

// Minimal WebSocket: handshake, text frames, Ready on open, pong for ping.
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
const frame = (text) => {
  const payload = Buffer.from(text)
  const header =
    payload.length < 126
      ? Buffer.from([0x81, payload.length])
      : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255])
  return Buffer.concat([header, payload])
}
server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"]
  const accept = createHash("sha1")
    .update(key + GUID)
    .digest("base64")
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )
  socket.write(frame(JSON.stringify({ _tag: "Ready" })))
  socket.on("data", (data) => {
    const opcode = data[0] & 0x0f
    if (opcode === 8) return socket.end()
    if (opcode !== 1) return
    let length = data[1] & 0x7f
    let offset = 2
    if (length === 126) {
      length = data.readUInt16BE(2)
      offset = 4
    }
    const mask = data.subarray(offset, offset + 4)
    const payload = Buffer.from(data.subarray(offset + 4, offset + 4 + length)).map(
      (byte, index) => byte ^ mask[index % 4],
    )
    if (payload.toString() === "ping") socket.write(frame("pong"))
  })
  socket.on("error", () => {})
})

server.listen(PORT, () => console.log(`mock api on http://localhost:${PORT}`))
