import type { Html, HtmlBuilder } from "foldkit/html"
import {
  Activity,
  ArrowLeft,
  Bell,
  Bot,
  Check,
  ChevronDown,
  ExternalLink,
  MessageSquare,
  RotateCw,
  Square,
  Trash2,
  TriangleAlert,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  FileText,
  GitPullRequest,
  Home,
  ListChecks,
  Pencil,
  Play,
  Plus,
  Search,
  Settings,
  Sparkles,
  Tag,
  X,
} from "lucide"

import * as Icon from "@/lib/icons"
import * as Routes from "@/routes"

/**
 * PROTOTYPE (throwaway). Three identity mockups for The Janitor at shadcn
 * Nova scale (14px body, 32px controls, 40px rows, 16px card padding),
 * switchable with ?variant=A|B|C on /prototype/identity. Static data, no
 * messages, no shell. Answers: "which visual identity do we want?"
 *
 *   A  Console, breathing   the current Ops Console DNA, rescaled to Nova
 *   B  Nova workbench       straight shadcn Nova, master-detail, no inspector
 *   C  Editorial            top nav, centered column, sentence-style rules
 */
export type ViewInputs = {
  readonly variant?: string | undefined
  readonly screen?: string | undefined
}

type Child = Html | string

/** Pages rendered inside the winning (A) identity. B and C only render "rules". */
export type Screen = "rules" | "editor" | "activity" | "sessions"
const screens: ReadonlyArray<{ key: Screen; name: string }> = [
  { key: "rules", name: "Rules" },
  { key: "editor", name: "Rule editor" },
  { key: "activity", name: "Activity" },
  { key: "sessions", name: "Sessions" },
]

// ---------------------------------------------------------------------------
// Fixture (borrowed from .scratch/ops-console-restyle/mock-api.mjs)
// ---------------------------------------------------------------------------

type Rule = {
  readonly id: string
  readonly label: string
  readonly color: string | null
  readonly policy: string
  readonly group: string | null
  readonly priority: number
  readonly enabled: boolean
  readonly ai: boolean
  readonly onMatch: string
  readonly onNoMatch: string
  readonly updated: string
  readonly sentence: string
}

const rules: ReadonlyArray<Rule> = [
  {
    id: "r1",
    label: "bug",
    color: "#d73a4a",
    policy: "pull-request-to-main",
    group: null,
    priority: 0,
    enabled: true,
    ai: false,
    onMatch: "Ensure present",
    onNoMatch: "Ensure absent",
    updated: "3 days ago",
    sentence: "When a pull request targets main, add bug. Otherwise remove it.",
  },
  {
    id: "r2",
    label: "needs-triage",
    color: "#fbca04",
    policy: "new-issue",
    group: "triage",
    priority: 3,
    enabled: true,
    ai: false,
    onMatch: "Ensure present",
    onNoMatch: "Take no action",
    updated: "5 days ago",
    sentence: "When an issue is opened with no assignee, add needs-triage.",
  },
  {
    id: "r3",
    label: "ai-suggested",
    color: "#0e8a16",
    policy: "new-issue",
    group: "triage",
    priority: 7,
    enabled: true,
    ai: true,
    onMatch: "Ensure present",
    onNoMatch: "Take no action",
    updated: "9 days ago",
    sentence: "When an issue is opened, ask the agent whether it describes a reproducible defect.",
  },
  {
    id: "r4",
    label: "stale",
    color: null,
    policy: "pull-request-to-main",
    group: null,
    priority: 12,
    enabled: false,
    ai: false,
    onMatch: "Ensure absent",
    onNoMatch: "Take no action",
    updated: "8 days ago",
    sentence: "When a pull request targets main, remove stale.",
  },
]

const selected: Rule = rules[2]!

const prompt = "Does {{fact:title}} together with {{fact:body}} describe a reproducible defect?"

type Entry = {
  readonly number: number
  readonly kind: "issue" | "pull_request"
  readonly title: string
  readonly when: string
  readonly day: "Today" | "Yesterday"
  readonly agent: boolean
  readonly actor: string
  readonly text: string
  readonly outcome: "applied" | "superseded" | "failed" | "skipped" | "human"
  readonly label?: string
}

const activity: ReadonlyArray<Entry> = [
  {
    number: 42,
    kind: "pull_request",
    title: "Fix interruption on save",
    when: "09:00",
    day: "Today",
    agent: true,
    actor: "The Janitor",
    text: "added",
    outcome: "applied",
    label: "bug",
  },
  {
    number: 42,
    kind: "pull_request",
    title: "Fix interruption on save",
    when: "08:58",
    day: "Today",
    agent: true,
    actor: "The Janitor",
    text: "skipped a run because a newer snapshot arrived",
    outcome: "superseded",
  },
  {
    number: 43,
    kind: "issue",
    title: "Crash on save",
    when: "08:40",
    day: "Today",
    agent: true,
    actor: "The Janitor",
    text: "could not add",
    outcome: "failed",
    label: "ai-suggested",
  },
  {
    number: 41,
    kind: "issue",
    title: "Docs: clarify Effect.gen",
    when: "17:12",
    day: "Yesterday",
    agent: false,
    actor: "mikearnaldi",
    text: "opened the issue",
    outcome: "human",
  },
  {
    number: 40,
    kind: "pull_request",
    title: "Bump esbuild",
    when: "16:03",
    day: "Yesterday",
    agent: true,
    actor: "The Janitor",
    text: "took no action: base is not main",
    outcome: "skipped",
  },
]

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

const el =
  <M>(h: HtmlBuilder<M>) =>
  (tag: "div" | "span" | "p" | "nav" | "aside" | "main" | "header" | "section" | "ul" | "li") =>
  (className: string, children: ReadonlyArray<Child>): Html =>
    h[tag]([h.Class(className)], children)

const swatch = <M>(h: HtmlBuilder<M>, color: string | null, size = "size-2"): Html =>
  h.span(
    [
      h.Class(`inline-block shrink-0 rounded-full ${size}`),
      h.Style({ backgroundColor: color ?? "#c7c7c7" }),
    ],
    [],
  )

const link = <M>(
  h: HtmlBuilder<M>,
  href: string,
  className: string,
  children: ReadonlyArray<Child>,
) => h.a([h.Href(href), h.Class(className)], children)

// ---------------------------------------------------------------------------
// Variant A — Console, breathing
// The Ops Console identity kept whole (blue = interactive, yellow = agent,
// mono = GitHub truth, hairlines, blueprint) and rescaled to Nova.
// ---------------------------------------------------------------------------

const variantA = <M>(h: HtmlBuilder<M>, screen: Screen = "rules"): Html => {
  const d = el(h)("div")
  const s = el(h)("span")

  const navItem = (icon: Html, label: string, active = false, count?: string) =>
    h.a(
      [
        h.Href("#"),
        h.Class(
          `flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm ${
            active
              ? "bg-primary-wash text-foreground font-medium"
              : "text-foreground hover:bg-surface-muted"
          }`,
        ),
      ],
      [
        icon,
        s("flex-1", [label]),
        ...(count === undefined
          ? []
          : [s("font-mono text-xs text-ink-subtle tabular-nums", [count])]),
      ],
    )

  const railItem = (icon: Html, active = false) =>
    h.a(
      [
        h.Href("#"),
        h.Class(
          `flex size-9 items-center justify-center rounded-md ${active ? "bg-primary-wash" : "hover:bg-surface-muted"}`,
        ),
      ],
      [icon],
    )

  const sidebarRail = h.aside(
    [h.Class("flex w-14 shrink-0 flex-col items-center border-r border-border bg-card")],
    [
      d("flex h-13 w-full items-center justify-center border-b border-border", [
        d("flex size-7 items-center justify-center rounded-md bg-foreground text-background", [
          Icon.view(h, Bot, "size-4"),
        ]),
      ]),
      d("flex flex-col items-center gap-4 py-3", [
        d(
          "flex size-9 items-center justify-center rounded-md border border-border font-mono text-xs font-semibold",
          ["EF"],
        ),
        d("flex flex-col gap-1", [
          railItem(Icon.view(h, Home, "size-4")),
          railItem(Icon.view(h, FileText, "size-4")),
          railItem(Icon.view(h, Tag, "size-4"), true),
          railItem(Icon.view(h, Activity, "size-4")),
          railItem(Icon.view(h, Settings, "size-4")),
        ]),
        d("flex flex-col gap-1 border-t border-border-subtle pt-3", [
          railItem(Icon.view(h, ListChecks, "size-4")),
        ]),
      ]),
    ],
  )

  const sidebarFull = h.aside(
    [h.Class("flex w-60 shrink-0 flex-col border-r border-border bg-card")],
    [
      d("flex h-13 items-center gap-3 border-b border-border px-4", [
        d("flex size-7 items-center justify-center rounded-md bg-foreground text-background", [
          Icon.view(h, Bot, "size-4"),
        ]),
        d("flex flex-col leading-tight", [
          s("text-sm font-semibold", ["The Janitor"]),
          s("text-xs text-ink-subtle", ["Repository maintenance"]),
        ]),
      ]),
      d("flex flex-col gap-5 p-3", [
        h.button(
          [
            h.Class(
              "flex h-11 items-center gap-3 rounded-md border border-border bg-card px-3 text-left hover:bg-surface-muted",
            ),
          ],
          [
            d(
              "flex size-7 items-center justify-center rounded-sm border border-border font-mono text-xs font-semibold",
              ["EF"],
            ),
            d("flex flex-1 flex-col leading-tight", [
              s("font-mono text-xs text-ink-subtle", ["effect"]),
              s("font-mono text-sm font-semibold", ["effect"]),
            ]),
            s("flex items-center gap-1.5 text-xs text-success", [
              s("size-1.5 rounded-full bg-success", []),
              "Active",
            ]),
            Icon.view(h, ChevronDown, "size-4 text-ink-subtle"),
          ],
        ),
        d("flex flex-col gap-1", [
          d("px-2.5 pb-1 text-xs font-medium text-ink-subtle", ["Repository"]),
          navItem(Icon.view(h, Home, "size-4"), "Overview"),
          navItem(Icon.view(h, FileText, "size-4"), "Policies", false, "3"),
          navItem(
            Icon.view(h, Tag, "size-4"),
            "Rules",
            screen === "rules" || screen === "editor",
            "4",
          ),
          navItem(Icon.view(h, Activity, "size-4"), "Activity", screen === "activity"),
          navItem(Icon.view(h, Settings, "size-4"), "Settings"),
        ]),
        d("flex flex-col gap-1", [
          d("px-2.5 pb-1 text-xs font-medium text-ink-subtle", ["Team"]),
          navItem(Icon.view(h, ListChecks, "size-4"), "Sessions", screen === "sessions", "2"),
        ]),
      ]),
    ],
  )

  const topbar = h.header(
    [h.Class("flex h-13 shrink-0 items-center gap-3 border-b border-border bg-card px-5")],
    [
      d("flex items-center gap-2 text-sm", [
        link(h, "#", "text-primary hover:underline", ["effect"]),
        s("text-ink-faint", ["/"]),
        link(h, "#", "text-primary hover:underline", ["effect"]),
        s("text-ink-faint", ["/"]),
        ...(screen === "editor"
          ? [
              link(h, "#", "text-primary hover:underline", ["Rules"]),
              s("text-ink-faint", ["/"]),
              s("font-mono font-semibold", ["ai-suggested"]),
            ]
          : [s("font-semibold", [screens.find((x) => x.key === screen)?.name ?? "Rules"])]),
      ]),
      d("ml-auto flex items-center gap-2", [
        d(
          "flex h-8 w-64 items-center gap-2 rounded-md border border-border bg-surface-muted px-2.5 text-sm text-ink-subtle",
          [Icon.view(h, Search, "size-4"), "Search", s("ml-auto font-mono text-xs", ["⌘K"])],
        ),
        d(
          "flex h-8 items-center gap-2 rounded-full border border-border px-3 text-xs font-medium",
          [s("size-2 rounded-full bg-agent", []), "Agent running"],
        ),
        h.button(
          [
            h.Class(
              "flex size-8 items-center justify-center rounded-md border border-border hover:bg-surface-muted",
            ),
          ],
          [Icon.view(h, Bell, "size-4")],
        ),
        d("size-8 rounded-full bg-ink-faint", []),
      ]),
    ],
  )

  const button = (label: ReadonlyArray<Child>, primary = false) =>
    h.button(
      [
        h.Class(
          `inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-3 text-sm font-medium transition-[transform,background-color] duration-120 ease-out active:scale-[0.96] ${
            primary
              ? "border-transparent bg-foreground text-background hover:bg-foreground/90"
              : "border-border bg-card hover:bg-surface-muted"
          }`,
        ),
      ],
      label,
    )

  const badge = (text: string, color: string | null, strike = false) =>
    s(
      `inline-flex h-6 items-center gap-1.5 rounded-sm border border-border bg-surface-muted px-2 font-mono text-xs ${strike ? "line-through text-ink-subtle" : ""}`,
      [swatch(h, color), text],
    )

  const switchView = (on: boolean) =>
    s(
      `relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${on ? "bg-success" : "bg-ink-faint"}`,
      [
        s(
          `absolute top-0.5 size-4 rounded-full bg-white shadow-sm ${on ? "left-[18px]" : "left-0.5"}`,
          [],
        ),
      ],
    )

  const th = (text: string, className = "") =>
    h.th([h.Class(`h-10 px-3 text-left text-xs font-medium text-ink-subtle ${className}`)], [text])
  const td = (children: ReadonlyArray<Child>, className = "") =>
    h.td([h.Class(`h-10 px-3 align-middle ${className}`)], children)

  const row = (r: Rule) =>
    h.tr(
      [
        h.Class(
          `border-b border-border-subtle last:border-0 ${
            r.id === selected.id ? "bg-primary-wash" : "hover:bg-surface-muted"
          }`,
        ),
      ],
      [
        td([switchView(r.enabled)]),
        td([
          r.ai
            ? s(
                "inline-flex h-6 items-center gap-1 rounded-sm border border-agent-line bg-agent-wash px-2 font-mono text-xs text-agent-ink",
                [Icon.view(h, Sparkles, "size-3"), "AI"],
              )
            : s(
                "inline-flex h-6 items-center rounded-sm border border-border bg-surface-muted px-2 font-mono text-xs",
                ["policy"],
              ),
        ]),
        td([badge(r.label, r.color, r.color === null)]),
        td([s("font-mono text-xs text-ink-muted", [r.policy])]),
        td([s("font-mono text-xs text-ink-muted", [r.group ?? "—"])]),
        td(
          [s("font-mono text-xs text-ink-muted tabular-nums", [String(r.priority)])],
          "text-right",
        ),
        td([s("text-sm text-ink-muted", [r.updated])]),
        td(
          [
            h.button(
              [
                h.Class(
                  "flex size-8 items-center justify-center rounded-md hover:bg-surface-muted",
                ),
              ],
              [Icon.view(h, Pencil, "size-4 text-ink-subtle")],
            ),
          ],
          "text-right",
        ),
      ],
    )

  const card = (header: ReadonlyArray<Child>, body: ReadonlyArray<Child>, flush = false) =>
    h.section(
      [h.Class("shrink-0 overflow-hidden rounded-lg border border-border bg-card")],
      [
        d("flex h-12 items-center gap-3 border-b border-border bg-surface-muted px-4", header),
        d(flush ? "" : "p-4", body),
      ],
    )

  const node = (kind: string, value: string, agent = false, selectedNode = false) =>
    d(
      `flex w-64 flex-col gap-1 rounded-md border bg-card px-3 py-2.5 whitespace-pre-line dark:bg-surface-muted ${
        selectedNode ? "border-primary ring-2 ring-primary-wash" : "border-border"
      }`,
      [
        d("flex items-center justify-between", [
          s("text-xs font-medium text-ink-subtle", [kind]),
          ...(agent
            ? [
                s(
                  "inline-flex h-5 items-center gap-1 rounded-sm border border-agent-line bg-agent-wash px-1.5 font-mono text-[11px] text-agent-ink",
                  [Icon.view(h, Sparkles, "size-3"), "AI"],
                ),
              ]
            : []),
        ]),
        s("font-mono text-xs leading-relaxed", [value]),
      ],
    )

  const wire = () => d("h-px w-8 shrink-0 bg-wire", [])
  const wireShort = () => d("h-px w-3 shrink-0 bg-wire", [])

  const blueprint = d("relative overflow-x-auto p-6 dark:[--oc-grid:rgb(122_165_240_/_0.13)]", [
    h.div(
      [
        h.Class("absolute inset-0"),
        h.Style({
          backgroundImage:
            "linear-gradient(to right, var(--oc-grid) 1px, transparent 1px), linear-gradient(to bottom, var(--oc-grid) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
        }),
      ],
      [],
    ),
    d("relative flex items-start gap-0", [
      d("flex flex-col gap-2", [
        s("text-xs font-medium text-ink-subtle", ["When"]),
        node("Event", "issues.opened, issues.edited"),
      ]),
      d("mt-7", [wire()]),
      d("flex flex-col gap-2", [
        s("text-xs font-medium text-ink-subtle", ["If every condition matches"]),
        d("flex flex-col gap-3", [
          node("Policy", "new-issue"),
          node("Agent", `confidence ≥ 0.8\n${prompt}`, true, true),
        ]),
      ]),
      d("mt-7", [wire()]),
      d("flex flex-col gap-2", [
        s("text-xs font-medium text-ink-subtle", ["Then"]),
        d("flex flex-col gap-3", [
          node("Match", "ensure ai-suggested present"),
          node("No match", "take no action"),
        ]),
      ]),
    ]),
  ])

  const feedItem = (e: Entry) =>
    d("flex items-start gap-3 border-b border-border-subtle px-4 py-3 last:border-0", [
      s(`mt-[7px] size-2 shrink-0 rounded-full ${e.agent ? "bg-agent" : "bg-ink-faint"}`, []),
      d("flex flex-1 flex-col gap-0.5", [
        d("flex flex-wrap items-center gap-x-1.5 text-sm leading-snug", [
          s(`font-semibold ${e.agent ? "text-agent-ink" : ""}`, [e.actor]),
          s("", [e.text]),
          ...(e.label === undefined
            ? []
            : [badge(e.label, rules.find((r) => r.label === e.label)?.color ?? null)]),
          s("", ["on"]),
          link(h, "#", "font-mono text-primary hover:underline", [`#${e.number}`]),
          s("text-ink-muted", [e.title]),
        ]),
      ]),
      s("font-mono text-xs text-ink-subtle", [`${e.day} ${e.when}`]),
    ])

  const kv = (k: string, v: string, mono = true) =>
    d("flex gap-3 py-1.5", [
      s("w-24 shrink-0 text-sm text-ink-muted", [k]),
      s(`text-sm ${mono ? "font-mono text-xs leading-5" : ""}`, [v]),
    ])

  const rulesInspector = h.aside(
    [
      h.Class(
        "flex w-80 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border bg-card p-4",
      ),
    ],
    [
      d("flex flex-col gap-2", [
        s("text-xs font-medium text-ink-subtle", ["Selection"]),
        d("rounded-md border border-border p-3", [
          d("flex items-center gap-2", [
            badge(selected.label, selected.color),
            s(
              "inline-flex h-6 items-center gap-1 rounded-sm border border-agent-line bg-agent-wash px-2 font-mono text-xs text-agent-ink",
              [Icon.view(h, Sparkles, "size-3"), "AI"],
            ),
          ]),
          d("mt-3 flex flex-col divide-y divide-border-subtle", [
            kv("Policy", "new-issue"),
            kv("Group", "triage"),
            kv("Priority", "7"),
            kv("Confidence", "≥ 0.80"),
            kv("Version", "1"),
            kv("Updated", "2026-09-05 11:05"),
          ]),
        ]),
      ]),
      d("flex flex-col gap-2", [
        s("text-xs font-medium text-ink-subtle", ["Dry run"]),
        d("rounded-md border border-border p-3", [
          h.p(
            [h.Class("text-sm text-ink-muted")],
            ["Evaluate this rule against the last 20 issues without applying labels."],
          ),
          d("mt-3", [button([Icon.view(h, Play, "size-4"), "Run as a test"])]),
        ]),
      ]),
      d("flex flex-col gap-2", [
        s("text-xs font-medium text-ink-subtle", ["History"]),
        d("rounded-md border border-border", [
          d("flex flex-col divide-y divide-border-subtle", [
            d("flex items-center gap-2 px-3 py-2 text-sm", [
              s("size-2 rounded-full bg-agent", []),
              s("font-semibold text-agent-ink", ["The Janitor"]),
              "proposed this rule",
              s("ml-auto font-mono text-xs text-ink-subtle", ["9d"]),
            ]),
            d("flex items-center gap-2 px-3 py-2 text-sm", [
              s("size-2 rounded-full bg-ink-faint", []),
              s("font-semibold", ["maxwell"]),
              "enabled it",
              s("ml-auto font-mono text-xs text-ink-subtle", ["9d"]),
            ]),
          ]),
        ]),
      ]),
    ],
  )

  const rulesMain = h.main(
    [h.Class("flex min-w-0 flex-1 flex-col gap-6 overflow-y-auto p-6")],
    [
      d("flex shrink-0 items-end justify-between gap-6", [
        d("flex max-w-[64ch] flex-col gap-1", [
          h.h1([h.Class("text-2xl font-semibold tracking-tight")], ["Labeling rules"]),
          h.p(
            [h.Class("text-sm text-ink-muted")],
            [
              "Connect policies to the labels they manage. Rules run top to bottom; the first match in a group wins.",
            ],
          ),
        ]),
        d("flex items-center gap-2", [
          button([Icon.view(h, Play, "size-4"), "Run all as a test"]),
          button([Icon.view(h, Plus, "size-4"), "New rule"], true),
        ]),
      ]),
      d("flex shrink-0 gap-6 border-b border-border text-sm", [
        s("-mb-px border-b-2 border-primary py-2.5 font-medium", ["Rules"]),
        s("py-2.5 text-ink-muted", ["Groups"]),
        s("py-2.5 text-ink-muted", ["Test bench"]),
      ]),
      card(
        [
          h.h3([h.Class("text-sm font-semibold")], ["Rules"]),
          s("font-mono text-xs text-ink-subtle", ["4 of 4"]),
          d(
            "ml-auto flex h-8 w-64 items-center gap-2 rounded-md border border-border bg-card px-2.5 text-sm text-ink-subtle",
            [Icon.view(h, Search, "size-4"), "Find a rule"],
          ),
        ],
        [
          h.table(
            [h.Class("w-full text-sm")],
            [
              h.thead(
                [h.Class("border-b border-border")],
                [
                  h.tr(
                    [],
                    [
                      th("Enabled"),
                      th("Type"),
                      th("Label"),
                      th("Policy"),
                      th("Group"),
                      th("Priority", "text-right"),
                      th("Updated"),
                      th(""),
                    ],
                  ),
                ],
              ),
              h.tbody([], rules.map(row)),
            ],
          ),
        ],
        true,
      ),
      card(
        [
          h.h3([h.Class("text-sm font-semibold")], ["ai-suggested"]),
          s("font-mono text-xs text-ink-subtle", ["r3 · v1"]),
          d("ml-auto flex items-center gap-2", [
            button([Icon.view(h, Pencil, "size-4"), "Edit"]),
            button(["Open YAML"]),
          ]),
        ],
        [blueprint],
        true,
      ),
      card(
        [
          h.h3([h.Class("text-sm font-semibold")], ["Recent activity"]),
          s("font-mono text-xs text-ink-subtle", ["5 events"]),
          link(h, "#", "ml-auto text-sm text-primary hover:underline", ["View all"]),
        ],
        activity.map(feedItem),
        true,
      ),
    ],
  )

  // ---- shared bits for the other pages -------------------------------------

  const inspectorSection = (title: string, body: ReadonlyArray<Child>) =>
    d("flex flex-col gap-2", [
      s("text-xs font-medium text-ink-subtle", [title]),
      d("rounded-md border border-border p-3", body),
    ])

  const aside = (children: ReadonlyArray<Child>) =>
    h.aside(
      [
        h.Class(
          "flex w-80 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border bg-card p-4",
        ),
      ],
      children,
    )

  const pageMain = (children: ReadonlyArray<Child>) =>
    h.main([h.Class("flex min-w-0 flex-1 flex-col gap-6 overflow-y-auto p-6")], children)

  const pageHeader = (title: Html, lede: string, actions: ReadonlyArray<Child>) =>
    d("flex shrink-0 items-end justify-between gap-6", [
      d("flex max-w-[64ch] flex-col gap-1", [
        title,
        h.p([h.Class("text-sm text-ink-muted")], [lede]),
      ]),
      d("flex items-center gap-2", actions),
    ])

  const field = (label: string, control: Html, help?: string) =>
    d("flex flex-col gap-1.5", [
      s("text-sm font-medium", [label]),
      control,
      ...(help === undefined ? [] : [s("text-sm text-ink-muted", [help])]),
    ])

  const select = (value: string, mono = true) =>
    d("flex h-8 items-center gap-2 rounded-md border border-border bg-card px-2.5", [
      s(`flex-1 ${mono ? "font-mono text-xs" : "text-sm"}`, [value]),
      Icon.view(h, ChevronDown, "size-4 text-ink-subtle"),
    ])

  const inputView = (value: string, mono = true) =>
    d("flex h-8 items-center rounded-md border border-border bg-card px-2.5", [
      s(mono ? "font-mono text-xs" : "text-sm", [value]),
    ])

  const dangerButton = (label: ReadonlyArray<Child>) =>
    h.button(
      [
        h.Class(
          "inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-transparent bg-destructive px-3 text-sm font-medium text-destructive-foreground transition-[transform,background-color] duration-120 ease-out hover:bg-destructive-hover active:scale-[0.96]",
        ),
      ],
      label,
    )

  const aiChip = () =>
    s(
      "inline-flex h-5 items-center gap-1 rounded-sm border border-agent-line bg-agent-wash px-1.5 font-mono text-[11px] text-agent-ink",
      [Icon.view(h, Sparkles, "size-3"), "AI"],
    )

  const junction = (text: string) =>
    s(
      "inline-flex h-6 items-center rounded-full border border-border bg-card px-2.5 text-xs text-ink-muted dark:bg-surface-muted",
      [text],
    )

  // ---- Rule editor -----------------------------------------------------------

  const editorNode = (
    kind: string,
    children: ReadonlyArray<Child>,
    opts: { agent?: boolean; width?: string } = {},
  ) =>
    d(
      `flex ${opts.width ?? "w-52"} flex-col gap-3 rounded-md border border-border bg-card p-3 dark:bg-surface-muted`,
      [
        d("flex items-center justify-between", [
          s("text-xs font-medium text-ink-subtle", [kind]),
          ...(opts.agent ? [aiChip()] : []),
        ]),
        ...children,
      ],
    )

  const slider = d("flex flex-col gap-2", [
    d("flex items-center justify-between", [
      s("text-sm font-medium", ["Minimum confidence"]),
      s("font-mono text-xs tabular-nums", ["80%"]),
    ]),
    d("relative h-1.5 rounded-full bg-ink-faint/40", [
      d("absolute inset-y-0 left-0 w-[80%] rounded-full bg-foreground", []),
      d(
        "absolute top-1/2 left-[80%] size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border border-border bg-card shadow-sm",
        [],
      ),
    ]),
    d("flex items-center gap-2", [
      s("flex-1 text-sm text-ink-muted", ["Below this score, use the non-match action."]),
      ...["70%", "80%", "95%"].map((v) =>
        s(
          `inline-flex h-7 items-center rounded-md border px-2.5 font-mono text-xs ${v === "80%" ? "border-border bg-primary-wash" : "border-border bg-card hover:bg-surface-muted"}`,
          [v],
        ),
      ),
    ]),
  ])

  const editorCanvas = d("relative overflow-x-auto p-6 dark:[--oc-grid:rgb(122_165_240_/_0.13)]", [
    h.div(
      [
        h.Class("absolute inset-0"),
        h.Style({
          backgroundImage:
            "linear-gradient(to right, var(--oc-grid) 1px, transparent 1px), linear-gradient(to bottom, var(--oc-grid) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
        }),
      ],
      [],
    ),
    d("relative flex items-start", [
      d("flex flex-col gap-2", [
        s("text-xs font-medium text-ink-subtle", ["When"]),
        d("flex flex-col gap-4", [
          editorNode("Applies to", [select("Issues", false)]),
          editorNode("Gate policy", [
            select("new-issue"),
            s("text-sm text-ink-muted", [
              "AI runs only when this policy matches. Otherwise, labels stay unchanged.",
            ]),
          ]),
        ]),
      ]),
      d("mt-9 flex items-center", [wireShort(), junction("gate"), wireShort()]),
      d("flex flex-col gap-2", [
        s("text-xs font-medium text-ink-subtle", ["If The Janitor classifies it"]),
        editorNode(
          "Classification",
          [
            d("flex items-center justify-between", [
              s("text-sm font-medium", ["Instructions"]),
              s("font-mono text-xs text-ink-subtle tabular-nums", ["79 / 4,000"]),
            ]),
            d(
              "min-h-32 rounded-md border border-border bg-card px-3 py-2.5 font-mono text-xs leading-relaxed",
              [prompt],
            ),
            s("text-sm text-ink-muted", [
              "Type {{ to reference a fact. Only referenced facts are used as evidence.",
            ]),
            slider,
          ],
          { agent: true, width: "w-[340px]" },
        ),
      ]),
      d("mt-9 flex flex-col gap-10", [
        d("flex items-center", [wireShort(), junction("match"), wireShort()]),
        d("flex items-center", [wireShort(), junction("no match"), wireShort()]),
      ]),
      d("flex flex-col gap-2", [
        s("text-xs font-medium text-ink-subtle", ["Then"]),
        d("flex flex-col gap-4", [
          editorNode("GitHub label", [select("ai-suggested")]),
          editorNode("On match", [select("Ensure present", false)]),
          editorNode("On no match", [select("Take no action", false)]),
        ]),
      ]),
    ]),
  ])

  const editorMain = pageMain([
    d("flex shrink-0 flex-col gap-4", [
      link(h, "#", "inline-flex items-center gap-1.5 text-sm text-primary hover:underline", [
        Icon.view(h, ArrowLeft, "size-4"),
        "Back to rules",
      ]),
      pageHeader(
        d("flex items-center gap-3", [
          h.h1([h.Class("font-mono text-2xl font-semibold tracking-tight")], ["ai-suggested"]),
          aiChip(),
        ]),
        "The Janitor uses the referenced facts to decide whether this label applies.",
        [
          d("mr-2 flex items-center gap-2 text-sm", ["Enabled", switchView(true)]),
          button(["Discard"]),
          button([Icon.view(h, Check, "size-4"), "Save rule"], true),
        ],
      ),
    ]),
    h.section(
      [h.Class("shrink-0 overflow-hidden rounded-lg border border-border bg-card")],
      [
        d("flex h-12 items-center gap-3 border-b border-border bg-surface-muted px-4", [
          h.h3([h.Class("text-sm font-semibold")], ["Rule graph"]),
          s("font-mono text-xs text-ink-subtle", ["ai rule"]),
        ]),
        editorCanvas,
        d(
          "flex h-10 items-center gap-3 border-t border-border bg-surface-muted px-4 text-sm text-ink-muted",
          [
            "Applies to a target, runs the classification, then acts on the label",
            s("ml-auto font-mono text-xs text-ink-subtle", ["6 nodes · 3 wires"]),
          ],
        ),
      ],
    ),
    h.p(
      [h.Class("max-w-[64ch] text-sm text-ink-muted")],
      [
        "Ensure present restores manually removed labels. Ensure absent removes manually added labels. Take no action makes no label request.",
      ],
    ),
    card(
      [
        h.h3([h.Class("text-sm font-semibold")], ["Exclusive group"]),
        s("font-mono text-xs text-ink-subtle", ["triage"]),
      ],
      [
        d("grid max-w-[640px] grid-cols-2 gap-6", [
          field(
            "Group",
            inputView("triage"),
            "Rules in a group compete. Only the highest priority match applies.",
          ),
          field("Priority", inputView("7"), "Larger priorities take precedence."),
        ]),
        d("mt-6 flex flex-col gap-2", [
          s("text-sm font-medium", ["Order in group"]),
          d("flex flex-col divide-y divide-border-subtle rounded-md border border-border", [
            d("flex h-10 items-center gap-3 px-3", [
              badge("ai-suggested", "#0e8a16"),
              s("font-mono text-xs text-ink-muted tabular-nums", ["7"]),
              d("ml-auto flex gap-1", [button(["Move up"]), button(["Move down"])]),
            ]),
            d("flex h-10 items-center gap-3 px-3", [
              badge("needs-triage", "#fbca04"),
              s("font-mono text-xs text-ink-muted tabular-nums", ["3"]),
              d("ml-auto flex gap-1", [button(["Move up"]), button(["Move down"])]),
            ]),
          ]),
        ]),
      ],
    ),
  ])

  const editorInspector = aside([
    inspectorSection("Test bench", [
      field("Issue", select("#7 · Crash on save", false)),
      d("mt-3", [button([Icon.view(h, Play, "size-4"), "Run as a test"])]),
      d("mt-4 flex flex-col gap-2 border-t border-border-subtle pt-3", [
        d("flex items-center gap-2", [
          s("size-2 rounded-full bg-agent", []),
          s("text-sm font-semibold text-agent-ink", ["Last result"]),
          s("ml-auto font-mono text-xs text-ink-subtle", ["2m ago"]),
        ]),
        d("flex items-center gap-2 text-sm", [
          s(
            "inline-flex h-6 items-center rounded-sm bg-success px-2 font-mono text-xs text-white",
            ["match"],
          ),
          s("font-mono text-xs text-ink-muted", ["0.91"]),
        ]),
        h.p(
          [h.Class("text-sm text-ink-muted")],
          ["The title names a crash and the body has reproduction steps."],
        ),
      ]),
    ]),
    inspectorSection("History", [
      d("flex flex-col divide-y divide-border-subtle", [
        d("flex items-center gap-2 py-2 text-sm", [
          s("size-2 rounded-full bg-agent", []),
          s("font-semibold text-agent-ink", ["The Janitor"]),
          "proposed this rule",
          s("ml-auto font-mono text-xs text-ink-subtle", ["9d"]),
        ]),
        d("flex items-center gap-2 py-2 text-sm", [
          s("size-2 rounded-full bg-ink-faint", []),
          s("font-semibold", ["maxwell"]),
          "enabled it",
          s("ml-auto font-mono text-xs text-ink-subtle", ["9d"]),
        ]),
      ]),
    ]),
    inspectorSection("Delete", [
      h.p(
        [h.Class("mb-3 text-sm text-ink-muted")],
        ["Removes the rule. Labels already applied stay on GitHub."],
      ),
      dangerButton([Icon.view(h, Trash2, "size-4"), "Delete rule"]),
    ]),
  ])

  // ---- Activity ---------------------------------------------------------------

  const outcomeChip = (o: "match" | "no match" | "applied" | "failed" | "superseded") =>
    s(
      `inline-flex h-6 items-center rounded-sm px-2 font-mono text-xs ${
        o === "applied" || o === "match"
          ? "bg-success text-white"
          : o === "failed"
            ? "bg-destructive text-white"
            : "border border-border bg-surface-muted text-ink-muted"
      }`,
      [o],
    )

  const subjectRow = (
    n: number,
    kind: "issue" | "pull_request",
    title: string,
    count: string,
    open = false,
    latest?: Html,
  ) =>
    d(`flex h-11 items-center gap-3 px-4 ${open ? "bg-primary-wash" : "hover:bg-surface-muted"}`, [
      Icon.view(h, open ? ChevronDown : ChevronRight, "size-4 text-ink-subtle"),
      Icon.view(h, kind === "issue" ? CircleDot : GitPullRequest, "size-4 text-ink-subtle"),
      link(h, "#", "font-mono text-xs text-primary hover:underline", [`#${n}`]),
      s("text-sm font-medium", [title]),
      ...(latest === undefined ? [] : [latest]),
      s("ml-auto font-mono text-xs text-ink-subtle", [count]),
    ])

  const runRow = (opts: {
    agent: boolean
    text: ReadonlyArray<Child>
    when: string
    body?: Html
  }) =>
    d("flex items-start gap-3 border-t border-border-subtle bg-card px-4 py-3 pl-12", [
      s(`mt-[7px] size-2 shrink-0 rounded-full ${opts.agent ? "bg-agent" : "bg-ink-faint"}`, []),
      d("flex min-w-0 flex-1 flex-col gap-2", [
        d("flex flex-wrap items-center gap-x-1.5 text-sm leading-snug", opts.text),
        ...(opts.body === undefined ? [] : [opts.body]),
      ]),
      s("font-mono text-xs text-ink-subtle", [opts.when]),
    ])

  const evaluationTable = h.table(
    [h.Class("w-full max-w-[720px] text-sm")],
    [
      h.thead(
        [h.Class("border-b border-border-subtle")],
        [
          h.tr(
            [],
            [th("Rule", "h-8"), th("Outcome", "h-8"), th("Reason", "h-8"), th("Action", "h-8")],
          ),
        ],
      ),
      h.tbody(
        [],
        [
          h.tr(
            [h.Class("border-b border-border-subtle")],
            [
              td([badge("bug", "#d73a4a")], "h-9"),
              td([outcomeChip("match")], "h-9"),
              td([s("font-mono text-xs text-ink-muted", ["baseRef equals main"])], "h-9"),
              td(
                [
                  d("flex items-center gap-2", [
                    s("font-mono text-xs", ["add"]),
                    outcomeChip("applied"),
                  ]),
                ],
                "h-9",
              ),
            ],
          ),
          h.tr(
            [],
            [
              td([badge("stale", null, true)], "h-9"),
              td([outcomeChip("no match")], "h-9"),
              td([s("font-mono text-xs text-ink-muted", ["rule disabled"])], "h-9"),
              td([s("text-sm text-ink-subtle", ["—"])], "h-9"),
            ],
          ),
        ],
      ),
    ],
  )

  const segment = (label: string, active = false) =>
    s(
      `inline-flex h-8 items-center whitespace-nowrap px-3 text-sm ${active ? "bg-primary-wash font-medium" : "text-ink-muted hover:bg-surface-muted"}`,
      [label],
    )

  const activityMain = pageMain([
    pageHeader(
      h.h1([h.Class("text-2xl font-semibold tracking-tight")], ["Activity"]),
      "Every evaluation The Janitor ran for this repository, newest first. Expand a subject to see what each rule decided.",
      [button([Icon.view(h, RotateCw, "size-4"), "Refresh"])],
    ),
    d("flex shrink-0 items-center gap-3", [
      d(
        "flex h-8 w-80 items-center gap-2 rounded-md border border-border bg-surface-muted px-2.5 text-sm text-ink-subtle",
        [Icon.view(h, Search, "size-4"), "Find an issue or pull request"],
      ),
      d("flex shrink-0 overflow-hidden rounded-md border border-border", [
        segment("Journal"),
        segment("By subject", true),
      ]),
      d("w-44 shrink-0", [select("All subjects", false)]),
      s("ml-auto whitespace-nowrap font-mono text-xs text-ink-subtle", [
        "6 evaluations · updated 09:02",
      ]),
    ]),
    h.section(
      [h.Class("shrink-0 overflow-hidden rounded-lg border border-border bg-card")],
      [
        d("flex flex-col divide-y divide-border-subtle", [
          d("", [
            subjectRow(42, "pull_request", "Fix interruption on save", "2 evaluations", true),
            runRow({
              agent: true,
              text: [
                s("font-semibold text-agent-ink", ["The Janitor"]),
                s("", ["evaluated revision"]),
                s("font-mono text-xs", ["7"]),
                s("text-ink-muted", ["· 1 change applied"]),
              ],
              when: "Today 09:00",
              body: evaluationTable,
            }),
            runRow({
              agent: true,
              text: [
                s("font-semibold text-agent-ink", ["The Janitor"]),
                s("", ["skipped a run"]),
                outcomeChip("superseded"),
                s("text-ink-muted", ["A newer snapshot arrived before this run finished."]),
              ],
              when: "Today 08:58",
            }),
          ]),
          subjectRow(43, "issue", "Crash on save", "1 evaluation", false, outcomeChip("failed")),
          subjectRow(44, "issue", "Update the README", "1 evaluation"),
          subjectRow(45, "pull_request", "Flaky integration test", "1 evaluation"),
          subjectRow(46, "issue", "Subject #46", "1 evaluation"),
        ]),
        d(
          "flex h-10 items-center border-t border-border bg-surface-muted px-4 text-sm text-ink-muted",
          ["6 evaluations loaded", s("ml-auto", ["End of activity"])],
        ),
      ],
    ),
  ])

  const activityInspector = aside([
    inspectorSection("Run", [
      d("flex flex-col divide-y divide-border-subtle", [
        kv("Subject", "#42 · PR"),
        kv("Revision", "7"),
        kv("Trigger", "pull_request.synchronize"),
        kv("Started", "2026-09-12 09:00:04"),
        kv("Duration", "1.8s"),
        kv("Outcome", "evaluated"),
      ]),
    ]),
    inspectorSection("Actions", [
      d("flex items-center gap-2 text-sm", [
        badge("bug", "#d73a4a"),
        s("font-mono text-xs", ["add"]),
        outcomeChip("applied"),
        s("ml-auto font-mono text-xs text-ink-subtle", ["r1"]),
      ]),
    ]),
    inspectorSection("Re-run", [
      h.p(
        [h.Class("mb-3 text-sm text-ink-muted")],
        ["Evaluate this subject again against the current rules. Labels may change."],
      ),
      button([Icon.view(h, Play, "size-4"), "Run again"]),
    ]),
  ])

  // ---- Sessions ---------------------------------------------------------------

  const statusPill = (state: "working" | "idle" | "blocked") =>
    state === "working"
      ? s(
          "inline-flex h-6 items-center gap-1.5 rounded-sm border border-agent-line bg-agent-wash px-2 font-mono text-xs text-agent-ink",
          [s("size-1.5 rounded-full bg-agent", []), "working"],
        )
      : state === "idle"
        ? s(
            "inline-flex h-6 items-center gap-1.5 rounded-sm border border-border bg-surface-muted px-2 font-mono text-xs text-ink-muted",
            [s("size-1.5 rounded-full bg-ink-faint", []), "idle"],
          )
        : s(
            "inline-flex h-6 items-center gap-1.5 rounded-sm border border-border bg-surface-muted px-2 font-mono text-xs text-destructive",
            [s("size-1.5 rounded-full bg-destructive", []), "blocked"],
          )

  const extLink = (icon: Html, label: string) =>
    link(h, "#", "inline-flex items-center gap-1 text-sm text-primary hover:underline", [
      icon,
      label,
      Icon.view(h, ExternalLink, "size-3 text-ink-subtle"),
    ])

  const sessionRow = (opts: {
    state: "working" | "idle" | "blocked"
    title: string
    reason?: string
    repo?: string
    at: string
    usage?: string
    links: ReadonlyArray<Html>
    warning?: string
    selectedRow?: boolean
  }) =>
    h.tr(
      [
        h.Class(
          `border-b border-border-subtle align-top last:border-0 ${opts.selectedRow ? "bg-primary-wash" : "hover:bg-surface-muted"}`,
        ),
      ],
      [
        td([statusPill(opts.state)], "py-3 whitespace-nowrap"),
        td(
          [
            d("flex flex-col gap-0.5", [
              d("flex items-center gap-2", [
                link(h, "#", "whitespace-nowrap text-sm font-medium text-primary hover:underline", [
                  opts.title,
                ]),
                opts.repo === undefined
                  ? s("text-xs text-ink-subtle", ["No repository yet"])
                  : s("font-mono text-xs text-ink-subtle", [opts.repo]),
              ]),
              ...(opts.reason === undefined ? [] : [s("text-sm text-ink-muted", [opts.reason])]),
              ...(opts.warning === undefined
                ? []
                : [
                    d("flex items-center gap-1.5 text-sm text-destructive", [
                      Icon.view(h, TriangleAlert, "size-3.5"),
                      opts.warning,
                    ]),
                  ]),
              ...(opts.links.length === 0 ? [] : [d("mt-1 flex items-center gap-3", opts.links)]),
            ]),
          ],
          "py-3",
        ),
        td(
          [s("font-mono text-xs text-ink-muted tabular-nums", [opts.at])],
          "py-3 whitespace-nowrap",
        ),
        td(
          [
            opts.usage === undefined
              ? s("text-sm text-ink-subtle", ["—"])
              : s("font-mono text-xs text-ink-muted tabular-nums", [opts.usage]),
          ],
          "py-3 text-right whitespace-nowrap",
        ),
      ],
    )

  const sessionsMain = pageMain([
    pageHeader(
      d("flex items-center gap-3", [
        h.h1([h.Class("text-2xl font-semibold tracking-tight")], ["Sessions"]),
        aiChip(),
      ]),
      "Every teammate sees the same sessions. Collaborate with an agent in its home thread; usage totals are recorded by OpenCode and are not a bill.",
      [
        button([Icon.view(h, RotateCw, "size-4"), "Refresh"]),
        button([Icon.view(h, Plus, "size-4"), "New session"], true),
      ],
    ),
    card(
      [
        h.h3([h.Class("text-sm font-semibold")], ["Sessions"]),
        s("font-mono text-xs text-ink-subtle", ["3 · 1 working"]),
        d("ml-auto w-40", [select("All states", false)]),
      ],
      [
        h.table(
          [h.Class("w-full text-sm")],
          [
            h.thead(
              [h.Class("border-b border-border")],
              [
                h.tr(
                  [],
                  [
                    th("State"),
                    th("Session", "w-full"),
                    th("Last activity"),
                    th("Usage", "text-right"),
                  ],
                ),
              ],
            ),
            h.tbody(
              [],
              [
                sessionRow({
                  state: "working",
                  title: "Fix the flaky test",
                  reason: "Input pending",
                  repo: "effect/effect",
                  at: "2026-09-13 10:00 UTC",
                  usage: "12,000 in · 500 out",
                  links: [
                    extLink(Icon.view(h, MessageSquare, "size-3.5"), "Home thread"),
                    extLink(Icon.view(h, GitPullRequest, "size-3.5"), "PR #17"),
                  ],
                  selectedRow: true,
                }),
                sessionRow({
                  state: "idle",
                  title: "Review the release notes",
                  repo: "effect/effect-smol",
                  at: "2026-09-13 08:12 UTC",
                  usage: "3,400 in · 220 out",
                  links: [],
                }),
                sessionRow({
                  state: "blocked",
                  title: "Slack conversation",
                  reason: "Waiting for repository selection",
                  at: "2026-09-12 21:40 UTC",
                  links: [extLink(Icon.view(h, MessageSquare, "size-3.5"), "Home thread")],
                  warning: "Delivery: Janitor is no longer in the channel",
                }),
              ],
            ),
          ],
        ),
      ],
      true,
    ),
  ])

  const sessionsInspector = aside([
    inspectorSection("Session", [
      d("mb-3 flex items-center gap-2", [
        statusPill("working"),
        s("text-sm font-medium", ["Fix the flaky test"]),
      ]),
      d("flex flex-col divide-y divide-border-subtle", [
        kv("Repository", "effect/effect"),
        kv("Pending inputs", "1"),
        kv("Accepted", "3"),
        kv("Last input", "2026-09-13 09:58"),
        kv("Runner read", "2026-09-13 10:00"),
      ]),
    ]),
    inspectorSection("Recovery", [
      h.p(
        [h.Class("mb-3 text-sm text-ink-muted")],
        ["Stop returns the runner to idle. Resume replays pending inputs."],
      ),
      d("flex gap-2", [
        button([Icon.view(h, Play, "size-4"), "Resume"]),
        button([Icon.view(h, Square, "size-4"), "Stop"]),
      ]),
    ]),
    inspectorSection("Delivery", [
      d("flex items-center gap-2 text-sm", [
        s("size-2 rounded-full bg-success", []),
        "Slack home thread",
        s("ml-auto font-mono text-xs text-ink-subtle", ["ok"]),
      ]),
    ]),
  ])

  const sidebar = screen === "editor" ? sidebarRail : sidebarFull

  const [main, inspector] =
    screen === "editor"
      ? [editorMain, editorInspector]
      : screen === "activity"
        ? [activityMain, activityInspector]
        : screen === "sessions"
          ? [sessionsMain, sessionsInspector]
          : [rulesMain, rulesInspector]

  return h.div(
    [
      h.Class(
        "flex h-screen w-screen overflow-hidden bg-background text-sm text-foreground antialiased",
      ),
    ],
    [
      sidebar,
      d("flex min-w-0 flex-1 flex-col", [topbar, d("flex min-h-0 flex-1", [main, inspector])]),
    ],
  )
}

// ---------------------------------------------------------------------------
// Variant B — Nova workbench
// Straight shadcn Nova: zinc neutrals, near-black primary, ring cards on a
// muted sidebar, pill badges, master-detail with no inspector. The agent is
// an amber "Janitor" badge, not a yellow marker. No blueprint grid.
// ---------------------------------------------------------------------------

const variantB = <M>(h: HtmlBuilder<M>): Html => {
  const d = el(h)("div")
  const s = el(h)("span")

  const vars = {
    "--background": "#ffffff",
    "--foreground": "#09090b",
    "--card": "#ffffff",
    "--primary": "#18181b",
    "--primary-foreground": "#fafafa",
    "--muted": "#f4f4f5",
    "--muted-foreground": "#71717a",
    "--border": "#e4e4e7",
    "--sidebar": "#fafafa",
    "--ring": "#a1a1aa",
    "--amber": "#b45309",
    "--amber-wash": "#fffbeb",
    "--amber-line": "#fde68a",
  }

  const button = (
    label: ReadonlyArray<Child>,
    variant: "primary" | "outline" | "ghost" = "outline",
    size: "sm" | "md" = "md",
  ) =>
    h.button(
      [
        h.Class(
          `inline-flex items-center gap-1.5 rounded-lg border text-sm font-medium transition-colors active:translate-y-px ${
            size === "sm" ? "h-7 px-2.5 text-[0.8rem]" : "h-8 px-2.5"
          } ${
            variant === "primary"
              ? "border-transparent bg-primary text-primary-foreground hover:bg-primary/90"
              : variant === "ghost"
                ? "border-transparent hover:bg-muted"
                : "border-border bg-card hover:bg-muted"
          }`,
        ),
      ],
      label,
    )

  const pill = (children: ReadonlyArray<Child>, className = "border-border bg-card") =>
    s(
      `inline-flex h-5 items-center gap-1 rounded-full border px-2 text-xs font-medium ${className}`,
      children,
    )

  const agentPill = () =>
    pill(
      [Icon.view(h, Sparkles, "size-3"), "Janitor"],
      "border-(--amber-line) bg-(--amber-wash) text-(--amber)",
    )

  const switchView = (on: boolean) =>
    s(
      `relative inline-flex h-[18px] w-8 shrink-0 rounded-full transition-colors ${on ? "bg-primary" : "bg-border"}`,
      [
        s(
          `absolute top-px size-4 rounded-full bg-white shadow-sm ${on ? "left-[15px]" : "left-px"}`,
          [],
        ),
      ],
    )

  const navItem = (icon: Html, label: string, active = false) =>
    h.a(
      [
        h.Href("#"),
        h.Class(
          `flex h-8 items-center gap-2 rounded-md px-2 text-sm ${active ? "bg-muted font-medium" : "text-foreground/80 hover:bg-muted"}`,
        ),
      ],
      [icon, label],
    )

  const sidebar = h.aside(
    [h.Class("flex w-64 shrink-0 flex-col gap-4 border-r border-border bg-sidebar p-3")],
    [
      h.button(
        [h.Class("flex h-10 items-center gap-2.5 rounded-lg px-2 text-left hover:bg-muted")],
        [
          d(
            "flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground",
            [Icon.view(h, Bot, "size-4")],
          ),
          d("flex flex-1 flex-col leading-tight", [
            s("text-sm font-medium", ["effect / effect"]),
            s("text-xs text-muted-foreground", ["3 repositories"]),
          ]),
          Icon.view(h, ChevronDown, "size-4 text-muted-foreground"),
        ],
      ),
      d(
        "flex h-8 items-center gap-2 rounded-lg border border-border bg-card px-2.5 text-sm text-muted-foreground",
        [Icon.view(h, Search, "size-4"), "Search", s("ml-auto text-xs", ["⌘K"])],
      ),
      d("flex flex-col gap-0.5", [
        d("h-8 px-2 text-xs font-medium leading-8 text-muted-foreground", ["Repository"]),
        navItem(Icon.view(h, Home, "size-4"), "Overview"),
        navItem(Icon.view(h, FileText, "size-4"), "Policies"),
        navItem(Icon.view(h, Tag, "size-4"), "Rules", true),
        navItem(Icon.view(h, Activity, "size-4"), "Activity"),
        navItem(Icon.view(h, Settings, "size-4"), "Settings"),
      ]),
      d("flex flex-col gap-0.5", [
        d("h-8 px-2 text-xs font-medium leading-8 text-muted-foreground", ["Team"]),
        navItem(Icon.view(h, ListChecks, "size-4"), "Sessions"),
      ]),
      d("mt-auto flex items-center gap-2 rounded-lg p-2 hover:bg-muted", [
        d("size-7 rounded-full bg-border", []),
        d("flex flex-col leading-tight", [
          s("text-sm font-medium", ["Maxwell Brown"]),
          s("text-xs text-muted-foreground", ["maxwellbrown1990"]),
        ]),
      ]),
    ],
  )

  const listRow = (r: Rule) =>
    h.a(
      [
        h.Href("#"),
        h.Class(
          `flex items-center gap-3 border-b border-border px-4 py-3 last:border-0 ${r.id === selected.id ? "bg-muted" : "hover:bg-muted/50"}`,
        ),
      ],
      [
        swatch(h, r.color, "size-2.5"),
        d("flex min-w-0 flex-1 flex-col gap-0.5", [
          d("flex items-center gap-2", [
            s(
              `text-sm font-medium ${r.color === null ? "line-through text-muted-foreground" : ""}`,
              [r.label],
            ),
            ...(r.ai ? [agentPill()] : []),
          ]),
          s("truncate text-xs text-muted-foreground", [
            `${r.policy}${r.group ? ` · ${r.group} #${r.priority}` : ""}`,
          ]),
        ]),
        switchView(r.enabled),
      ],
    )

  const step = (
    label: string,
    title: string,
    body: ReadonlyArray<Child>,
    last = false,
    agent = false,
  ) =>
    d("relative flex gap-4", [
      d("flex flex-col items-center", [
        d(
          `flex size-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold ${agent ? "border-(--amber-line) bg-(--amber-wash) text-(--amber)" : "border-border bg-card"}`,
          [label],
        ),
        ...(last ? [] : [d("w-px flex-1 bg-border", [])]),
      ]),
      d(`flex flex-1 flex-col gap-2 ${last ? "" : "pb-6"}`, [
        s("text-sm font-medium", [title]),
        ...body,
      ]),
    ])

  const code = (text: string) =>
    d("rounded-lg bg-muted px-3 py-2 font-mono text-xs leading-relaxed", [text])

  const outcomePill = (o: Entry["outcome"]) =>
    o === "applied"
      ? pill(
          [Icon.view(h, Check, "size-3"), "Applied"],
          "border-transparent bg-emerald-50 text-emerald-700",
        )
      : o === "failed"
        ? pill([Icon.view(h, X, "size-3"), "Failed"], "border-transparent bg-red-50 text-red-700")
        : o === "superseded"
          ? pill(["Superseded"], "border-transparent bg-muted text-muted-foreground")
          : o === "skipped"
            ? pill(["Skipped"], "border-transparent bg-muted text-muted-foreground")
            : pill(["Human"], "border-transparent bg-muted text-muted-foreground")

  const feedItem = (e: Entry) =>
    d("flex items-start gap-3 py-3", [
      d(
        `flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${e.agent ? "bg-(--amber-wash) text-(--amber)" : "bg-muted"}`,
        [e.agent ? Icon.view(h, Sparkles, "size-4") : "M"],
      ),
      d("flex min-w-0 flex-1 flex-col gap-1", [
        d("flex flex-wrap items-center gap-x-1.5 text-sm", [
          s("font-medium", [e.actor]),
          s("text-muted-foreground", [e.text]),
          ...(e.label === undefined
            ? []
            : [pill([swatch(h, rules.find((r) => r.label === e.label)?.color ?? null), e.label])]),
        ]),
        d("flex items-center gap-1.5 text-xs text-muted-foreground", [
          Icon.view(h, e.kind === "issue" ? CircleDot : GitPullRequest, "size-3.5"),
          `#${e.number} ${e.title}`,
          s("mx-1", ["·"]),
          `${e.day} ${e.when}`,
        ]),
      ]),
      outcomePill(e.outcome),
    ])

  const detail = h.section(
    [
      h.Class(
        "flex min-w-0 flex-1 flex-col gap-4 rounded-xl bg-card p-4 ring-1 ring-foreground/10",
      ),
    ],
    [
      d("flex items-start gap-3", [
        swatch(h, selected.color, "mt-1.5 size-3"),
        d("flex flex-1 flex-col gap-1", [
          d("flex items-center gap-2", [
            h.h2([h.Class("text-base font-medium")], ["ai-suggested"]),
            agentPill(),
          ]),
          h.p([h.Class("text-sm text-muted-foreground")], [selected.sentence]),
        ]),
        d("flex items-center gap-2", [
          switchView(true),
          button([Icon.view(h, Play, "size-4"), "Test"]),
          button([Icon.view(h, Pencil, "size-4"), "Edit"], "primary"),
        ]),
      ]),
      d("h-px bg-border", []),
      d("flex flex-col", [
        step("1", "When an issue is opened or edited", [code("issues.opened · issues.edited")]),
        step("2", "If the new-issue policy matches", [
          code("policy: new-issue  ·  3 conditions"),
          s("text-xs text-muted-foreground", [
            "Gate policy. The agent only runs when this passes.",
          ]),
        ]),
        step(
          "3",
          "Ask the agent",
          [
            code(prompt),
            d("flex items-center gap-2 text-xs text-muted-foreground", [
              "Minimum confidence",
              pill(["0.80"]),
            ]),
          ],
          false,
          true,
        ),
        step(
          "4",
          "Then",
          [
            d("grid grid-cols-2 gap-2", [
              d("rounded-lg border border-border p-3", [
                s("block text-xs text-muted-foreground", ["On match"]),
                s("text-sm", ["Ensure ai-suggested is present"]),
              ]),
              d("rounded-lg border border-border p-3", [
                s("block text-xs text-muted-foreground", ["On no match"]),
                s("text-sm", ["Take no action"]),
              ]),
            ]),
          ],
          true,
        ),
      ]),
      d("h-px bg-border", []),
      d("flex flex-col gap-1", [
        d("flex items-center justify-between", [
          h.h3([h.Class("text-sm font-medium")], ["Recent activity"]),
          button(["View all"], "ghost", "sm"),
        ]),
        d("flex flex-col divide-y divide-border", activity.map(feedItem)),
      ]),
    ],
  )

  const main = h.main(
    [h.Class("flex min-w-0 flex-1 flex-col overflow-y-auto")],
    [
      h.header(
        [h.Class("flex h-14 shrink-0 items-center gap-2 border-b border-border px-6")],
        [
          s("text-sm text-muted-foreground", ["effect / effect"]),
          s("text-muted-foreground", ["/"]),
          s("text-sm font-medium", ["Rules"]),
          d("ml-auto flex items-center gap-2", [
            button([Icon.view(h, Play, "size-4"), "Run all as a test"]),
            button([Icon.view(h, Plus, "size-4"), "New rule"], "primary"),
          ]),
        ],
      ),
      d("flex flex-col gap-5 p-6", [
        d("flex flex-col gap-1", [
          h.h1([h.Class("text-xl font-semibold tracking-tight")], ["Rules"]),
          h.p(
            [h.Class("text-sm text-muted-foreground")],
            ["Connect policies to the labels they manage. Select a rule to see how it decides."],
          ),
        ]),
        d("flex items-start gap-5", [
          h.section(
            [
              h.Class(
                "flex w-[360px] shrink-0 flex-col overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10",
              ),
            ],
            [
              d("flex items-center gap-2 border-b border-border px-4 py-3", [
                h.h2([h.Class("text-sm font-medium")], ["All rules"]),
                pill(["4"]),
                d(
                  "ml-auto flex h-7 items-center gap-2 rounded-lg border border-border px-2 text-[0.8rem] text-muted-foreground",
                  [Icon.view(h, Search, "size-3.5"), "Filter"],
                ),
              ]),
              d("flex flex-col", rules.map(listRow)),
            ],
          ),
          detail,
        ]),
      ]),
    ],
  )

  return h.div(
    [
      h.Class(
        "flex h-screen w-screen overflow-hidden bg-background text-sm text-foreground antialiased",
      ),
      h.Style(vars),
    ],
    [sidebar, main],
  )
}

// ---------------------------------------------------------------------------
// Variant C — Editorial
// No sidebar. Top navigation with section tabs, a centered 1120px column,
// 15px body, warm stone neutrals, indigo for interaction, rules written as
// sentences instead of a table. Detail expands in place.
// ---------------------------------------------------------------------------

const variantC = <M>(h: HtmlBuilder<M>): Html => {
  const d = el(h)("div")
  const s = el(h)("span")

  const vars = {
    "--background": "#f8f7f4",
    "--foreground": "#1c1917",
    "--card": "#ffffff",
    "--primary": "#4f46e5",
    "--primary-foreground": "#ffffff",
    "--muted": "#f1efea",
    "--muted-foreground": "#78716c",
    "--border": "#e7e5e4",
    "--ring": "#4f46e5",
    "--amber": "#b45309",
    "--amber-wash": "#fef3c7",
  }

  const button = (label: ReadonlyArray<Child>, primary = false) =>
    h.button(
      [
        h.Class(
          `inline-flex h-9 items-center gap-2 rounded-lg px-3.5 text-[15px] font-medium transition-transform active:scale-[0.97] ${primary ? "bg-primary text-primary-foreground hover:bg-primary/90" : "border border-border bg-card hover:bg-muted"}`,
        ),
      ],
      label,
    )

  const tab = (label: string, active = false) =>
    h.a(
      [
        h.Href("#"),
        h.Class(
          `-mb-px border-b-2 px-1 pb-3 text-[15px] ${active ? "border-foreground font-medium" : "border-transparent text-muted-foreground hover:text-foreground"}`,
        ),
      ],
      [label],
    )

  const topbar = h.header(
    [h.Class("border-b border-border bg-card")],
    [
      d("mx-auto flex h-16 max-w-[1120px] items-center gap-4 px-6", [
        d("flex items-center gap-2.5", [
          d("flex size-8 items-center justify-center rounded-lg bg-foreground text-background", [
            Icon.view(h, Bot, "size-4"),
          ]),
          s("text-[15px] font-semibold tracking-tight", ["The Janitor"]),
        ]),
        s("text-border", ["/"]),
        h.button(
          [
            h.Class(
              "flex h-9 items-center gap-2 rounded-lg border border-border bg-card px-3 text-[15px] hover:bg-muted",
            ),
          ],
          [
            s("size-5 rounded bg-muted text-[10px] font-bold leading-5 text-center", ["EF"]),
            "effect/effect",
            Icon.view(h, ChevronDown, "size-4 text-muted-foreground"),
          ],
        ),
        d("ml-auto flex items-center gap-3", [
          d(
            "flex h-9 w-64 items-center gap-2 rounded-lg border border-border bg-background px-3 text-[15px] text-muted-foreground",
            [Icon.view(h, Search, "size-4"), "Search"],
          ),
          d(
            "flex h-9 items-center gap-2 rounded-full bg-(--amber-wash) px-3 text-sm font-medium text-(--amber)",
            [Icon.view(h, Sparkles, "size-4"), "Working on #43"],
          ),
          d("size-9 rounded-full bg-border", []),
        ]),
      ]),
      d("mx-auto flex max-w-[1120px] gap-6 px-6 pt-2", [
        tab("Overview"),
        tab("Policies"),
        tab("Rules", true),
        tab("Activity"),
        tab("Settings"),
        tab("Sessions"),
      ]),
    ],
  )

  const switchView = (on: boolean) =>
    s(
      `relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors ${on ? "bg-primary" : "bg-border"}`,
      [
        s(
          `absolute top-0.5 size-5 rounded-full bg-white shadow-sm ${on ? "left-[22px]" : "left-0.5"}`,
          [],
        ),
      ],
    )

  const chip = (children: ReadonlyArray<Child>, className = "bg-muted text-muted-foreground") =>
    s(
      `inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium ${className}`,
      children,
    )

  const expanded = d("mt-5 grid grid-cols-3 gap-8 border-t border-border pt-5", [
    d("flex flex-col gap-2", [
      s("text-[13px] font-medium uppercase tracking-wide text-muted-foreground", ["When"]),
      h.p([h.Class("text-[15px] leading-relaxed")], ["An issue is opened or edited."]),
    ]),
    d("flex flex-col gap-2", [
      s("text-[13px] font-medium uppercase tracking-wide text-muted-foreground", ["If"]),
      h.p(
        [h.Class("text-[15px] leading-relaxed")],
        [
          "The ",
          link(h, "#", "text-primary underline-offset-4 hover:underline", ["new-issue"]),
          " policy matches, and the agent answers yes with at least 80% confidence to:",
        ],
      ),
      d(
        "rounded-lg border border-(--amber-wash) bg-(--amber-wash)/40 px-3 py-2.5 font-mono text-[13px] leading-relaxed",
        [prompt],
      ),
    ]),
    d("flex flex-col gap-2", [
      s("text-[13px] font-medium uppercase tracking-wide text-muted-foreground", ["Then"]),
      h.p(
        [h.Class("text-[15px] leading-relaxed")],
        [
          "Add ",
          chip([swatch(h, selected.color), "ai-suggested"], "bg-muted"),
          ". If it does not match, leave the issue alone.",
        ],
      ),
      d("mt-auto flex gap-2 pt-2", [
        button([Icon.view(h, Play, "size-4"), "Run as a test"]),
        button([Icon.view(h, Pencil, "size-4"), "Edit rule"]),
      ]),
    ]),
  ])

  const ruleRow = (r: Rule) =>
    d(
      `flex flex-col px-6 py-5 ${r.id === selected.id ? "bg-card" : ""} border-b border-border last:border-0`,
      [
        d("flex items-center gap-4", [
          swatch(h, r.color, "size-3"),
          d("flex min-w-0 flex-1 flex-col gap-0.5", [
            d("flex items-center gap-2.5", [
              s(
                `text-[15px] font-semibold ${r.color === null ? "line-through text-muted-foreground" : ""}`,
                [r.label],
              ),
              ...(r.ai
                ? [
                    chip(
                      [Icon.view(h, Sparkles, "size-3.5"), "Asks the agent"],
                      "bg-(--amber-wash) text-(--amber)",
                    ),
                  ]
                : []),
              ...(r.color === null
                ? [chip(["Label missing on GitHub"], "bg-red-50 text-red-700")]
                : []),
            ]),
            h.p([h.Class("text-[15px] text-muted-foreground")], [r.sentence]),
          ]),
          ...(r.group === null ? [] : [chip([`${r.group} · ${r.priority}`])]),
          s("w-24 text-right text-[13px] text-muted-foreground", [r.updated]),
          switchView(r.enabled),
        ]),
        ...(r.id === selected.id ? [expanded] : []),
      ],
    )

  const dayGroup = (day: Entry["day"]) =>
    d("flex flex-col gap-4", [
      s("text-[13px] font-medium uppercase tracking-wide text-muted-foreground", [day]),
      d(
        "flex flex-col gap-4 border-l border-border pl-6",
        activity
          .filter((e) => e.day === day)
          .map((e) =>
            d("relative flex items-start gap-3", [
              d(
                `absolute -left-[31px] top-1 size-2.5 rounded-full ring-4 ring-background ${e.agent ? "bg-(--amber)" : "bg-border"}`,
                [],
              ),
              d("flex min-w-0 flex-1 flex-col gap-0.5", [
                h.p(
                  [h.Class("text-[15px] leading-relaxed")],
                  [
                    s(`font-semibold ${e.agent ? "text-(--amber)" : ""}`, [e.actor]),
                    ` ${e.text} `,
                    ...(e.label === undefined
                      ? []
                      : [
                          chip([
                            swatch(h, rules.find((r) => r.label === e.label)?.color ?? null),
                            e.label,
                          ]),
                          " to ",
                        ]),
                    link(h, "#", "font-medium text-primary underline-offset-4 hover:underline", [
                      `#${e.number} ${e.title}`,
                    ]),
                    ...(e.outcome === "failed"
                      ? [chip(["Failed"], "ml-2 bg-red-50 text-red-700")]
                      : []),
                  ],
                ),
                s("text-[13px] text-muted-foreground", [e.when]),
              ]),
            ]),
          ),
      ),
    ])

  const main = h.main(
    [h.Class("mx-auto flex w-full max-w-[1120px] flex-col gap-10 px-6 py-10")],
    [
      d("flex items-end justify-between gap-8", [
        d("flex flex-col gap-2", [
          h.h1([h.Class("text-[28px] font-semibold tracking-tight")], ["Rules"]),
          h.p(
            [h.Class("max-w-[60ch] text-[15px] text-muted-foreground")],
            [
              "Each rule connects a policy to a label. Rules in the same group run in priority order and the first match wins.",
            ],
          ),
        ]),
        d("flex items-center gap-2", [
          button([Icon.view(h, Play, "size-4"), "Run all as a test"]),
          button([Icon.view(h, Plus, "size-4"), "New rule"], true),
        ]),
      ]),
      h.section(
        [h.Class("overflow-hidden rounded-xl border border-border bg-card/60")],
        [d("flex flex-col", rules.map(ruleRow))],
      ),
      h.section(
        [h.Class("flex flex-col gap-6")],
        [
          d("flex items-baseline justify-between", [
            h.h2([h.Class("text-xl font-semibold tracking-tight")], ["Activity"]),
            link(h, "#", "text-[15px] text-primary underline-offset-4 hover:underline", [
              "See everything",
            ]),
          ]),
          dayGroup("Today"),
          dayGroup("Yesterday"),
        ],
      ),
    ],
  )

  return h.div(
    [
      h.Class(
        "min-h-screen w-screen overflow-y-auto bg-background text-[15px] text-foreground antialiased",
      ),
      h.Style(vars),
    ],
    [topbar, main],
  )
}

// ---------------------------------------------------------------------------
// Switcher
// ---------------------------------------------------------------------------

const variants = [
  {
    key: "A",
    name: "Console, breathing",
    render: variantA as <M>(h: HtmlBuilder<M>, screen: Screen) => Html,
  },
  {
    key: "B",
    name: "Nova workbench",
    render: <M>(h: HtmlBuilder<M>, _screen: Screen) => variantB(h),
  },
  { key: "C", name: "Editorial", render: <M>(h: HtmlBuilder<M>, _screen: Screen) => variantC(h) },
] as const

type Variant = (typeof variants)[number]

const switcher = <M>(h: HtmlBuilder<M>, current: Variant, screen: Screen): Html => {
  const index = variants.findIndex((v) => v.key === current.key)
  const previous = variants[(index + variants.length - 1) % variants.length]!
  const next = variants[(index + 1) % variants.length]!
  const arrow = (target: Variant, icon: Html) =>
    h.a(
      [
        h.Href(Routes.prototype({ variant: target.key, screen })),
        h.Class("flex size-8 items-center justify-center rounded-full hover:bg-white/15"),
      ],
      [icon],
    )
  return h.div(
    [
      h.Class(
        "fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full bg-zinc-900 p-1 font-sans text-sm text-white shadow-[0_8px_24px_rgb(0_0_0/0.35)] ring-1 ring-white/10",
      ),
    ],
    [
      arrow(previous, Icon.view(h, ChevronLeft, "size-4")),
      h.span(
        [h.Class("px-2 tabular-nums")],
        [h.span([h.Class("font-semibold")], [current.key]), ` · ${current.name}`],
      ),
      ...variants.map((v) =>
        h.a(
          [
            h.Href(Routes.prototype({ variant: v.key, screen })),
            h.Class(
              `flex size-7 items-center justify-center rounded-full text-xs font-semibold ${v.key === current.key ? "bg-white text-zinc-900" : "text-white/60 hover:bg-white/15"}`,
            ),
          ],
          [v.key],
        ),
      ),
      arrow(next, Icon.view(h, ChevronRight, "size-4")),
      ...(current.key === "A"
        ? [
            h.span([h.Class("mx-1 h-5 w-px bg-white/20")], []),
            ...screens.map((sc) =>
              h.a(
                [
                  h.Href(Routes.prototype({ variant: current.key, screen: sc.key })),
                  h.Class(
                    `flex h-7 items-center rounded-full px-2.5 text-xs font-medium ${sc.key === screen ? "bg-white text-zinc-900" : "text-white/60 hover:bg-white/15"}`,
                  ),
                ],
                [sc.name],
              ),
            ),
          ]
        : []),
    ],
  )
}

export const view = <M>(h: HtmlBuilder<M>, inputs: ViewInputs): Html => {
  const current = variants.find((v) => v.key === (inputs.variant ?? "A")) ?? variants[0]
  const screen = screens.find((x) => x.key === inputs.screen)?.key ?? "rules"
  return h.div([h.Class("relative")], [current.render(h, screen), switcher(h, current, screen)])
}
