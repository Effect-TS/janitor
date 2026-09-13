import type { Html, HtmlBuilder } from "foldkit/html"
import { Check, Pencil, Plus, Search } from "lucide"

import * as Icon from "@/lib/icons"
import { cn } from "@/lib/utils"
import * as Blueprint from "@/components/ui/blueprint"
import * as Button from "@/components/ui/button"
import { chip, chipVariants, type ChipVariant } from "@/components/ui/chip"
import * as Dialog from "@/components/ui/dialog"
import * as Feed from "@/components/ui/feed"
import { input } from "@/components/ui/input"
import { inputGroup, inputGroupAddon, inputGroupInput } from "@/components/ui/input-group"
import * as Inspector from "@/components/ui/inspector"
import { avatar, platformMark } from "@/components/ui/mark"
import * as Overlay from "@/components/ui/overlay"
import { emptyPanel, panel, panelHeader } from "@/components/ui/panel"
import { rack } from "@/components/ui/rack"
import * as Select from "@/components/ui/select"
import { sign } from "@/components/ui/sign"
import { skeleton } from "@/components/ui/skeleton"
import * as Switch from "@/components/ui/switch"
import * as Table from "@/components/ui/table"
import { textarea } from "@/components/ui/textarea"

/**
 * Every primitive in every variant and state, in both themes. This page is
 * how the restyle is checked; it renders no live data and dispatches only a
 * no-op message. It is a deliverable, listed in RESTYLE-REPORT.md.
 */
export type ViewInputs<M> = {
  readonly noop: M
}

type Child = Html | string

const focusDemoClass = "outline-2 outline-ring outline-offset-1"

const block = <M>(h: HtmlBuilder<M>, title: string, children: ReadonlyArray<Child>): Html =>
  h.section(
    [h.Class("flex flex-col gap-3")],
    [sign(h, { children: [title] }), h.div([h.Class("flex flex-col gap-3")], children)],
  )

const row = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Child>): Html =>
  h.div([h.Class("flex flex-wrap items-center gap-2")], children)

const caption = <M>(h: HtmlBuilder<M>, text: string): Html =>
  h.div([h.Class("text-caption font-medium text-ink-subtle")], [text])

const specimen = <M>(h: HtmlBuilder<M>, name: string, sample: Html): Html =>
  h.div(
    [h.Class("flex items-baseline gap-3")],
    [h.span([h.Class("w-22 shrink-0")], [caption(h, name)]), sample],
  )

const typography = <M>(h: HtmlBuilder<M>): Html =>
  block(h, "Typography", [
    panel(h, {
      children: [
        h.div(
          [h.Class("flex flex-col gap-1.5")],
          [
            specimen(h, "h1", h.h1([], ["Labeling rules"])),
            specimen(h, "h2", h.h2([], ["Section heading"])),
            specimen(h, "h3", h.h3([], ["Card header"])),
            specimen(
              h,
              "body-md",
              h.p(
                [h.Class("text-body-md")],
                ["Default body copy caps at sixty-six characters per line."],
              ),
            ),
            specimen(h, "label", h.span([h.Class("text-label font-medium")], ["Form label"])),
            specimen(
              h,
              "body-sm",
              h.span([h.Class("text-body-sm text-ink-muted")], ["Help text sits under its label."]),
            ),
            specimen(
              h,
              "caption",
              h.span([h.Class("text-caption font-medium text-ink-subtle")], ["Column head"]),
            ),
            specimen(
              h,
              "mono-md",
              h.span([h.Class("font-mono text-mono-md")], ["effect-ts/effect / main"]),
            ),
            specimen(
              h,
              "mono-sm",
              h.span(
                [h.Class("font-mono text-mono-sm")],
                ['labels.any("bug") && title.matches(/panic/)'],
              ),
            ),
            specimen(
              h,
              "mono-xs",
              h.span(
                [h.Class("font-mono text-mono-xs text-ink-subtle")],
                ["run_01J8Z7 · 12:04:31"],
              ),
            ),
            specimen(
              h,
              "numeral",
              h.span(
                [h.Class("font-mono text-numeral font-medium tabular-nums")],
                ["1,204  38  7"],
              ),
            ),
          ],
        ),
      ],
    }),
  ])

const swatch = <M>(h: HtmlBuilder<M>, name: string, className: string): Html =>
  h.div(
    [h.Class("flex items-center gap-2")],
    [
      h.span([h.Class(cn("size-5 rounded-xs border border-border", className))], []),
      h.span([h.Class("font-mono text-mono-xs")], [name]),
    ],
  )

const colors = <M>(h: HtmlBuilder<M>): Html =>
  block(h, "Colors", [
    panel(h, {
      children: [
        h.div(
          [h.Class("grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-3 lg:grid-cols-4")],
          [
            swatch(h, "background", "bg-background"),
            swatch(h, "card", "bg-card"),
            swatch(h, "surface-muted", "bg-surface-muted"),
            swatch(h, "border", "bg-border"),
            swatch(h, "border-subtle", "bg-border-subtle"),
            swatch(h, "foreground", "bg-foreground"),
            swatch(h, "ink-muted", "bg-ink-muted"),
            swatch(h, "ink-subtle", "bg-ink-subtle"),
            swatch(h, "ink-faint (marks only)", "bg-ink-faint"),
            swatch(h, "primary", "bg-primary"),
            swatch(h, "primary-hover", "bg-primary-hover"),
            swatch(h, "primary-wash", "bg-primary-wash"),
            swatch(h, "primary-line", "bg-primary-line"),
            swatch(h, "agent (marks only)", "bg-agent"),
            swatch(h, "agent-ink", "bg-agent-ink"),
            swatch(h, "agent-wash", "bg-agent-wash"),
            swatch(h, "agent-line", "bg-agent-line"),
            swatch(h, "success", "bg-success"),
            swatch(h, "destructive", "bg-destructive"),
            swatch(h, "wire", "bg-wire"),
          ],
        ),
      ],
    }),
  ])

const buttons = <M>(h: HtmlBuilder<M>, noop: M): Html => {
  const variants = ["default", "secondary", "destructive", "ghost", "link"] as const
  const states = (variant: (typeof variants)[number]): ReadonlyArray<Html> => [
    Button.view(h, { variant, label: "Default", onClick: noop }),
    Button.view(h, {
      variant,
      label: "Hover",
      onClick: noop,
      className:
        variant === "default"
          ? "bg-primary-hover border-primary-hover"
          : variant === "destructive"
            ? "bg-destructive-hover border-destructive-hover"
            : variant === "link"
              ? "underline"
              : "bg-surface-muted",
    }),
    Button.view(h, { variant, label: "Focus", onClick: noop, className: focusDemoClass }),
    Button.view(h, { variant, label: "Disabled", isDisabled: true }),
    Button.view(h, {
      variant,
      label: "Saving…",
      onClick: noop,
      isDisabled: true,
      attributes: [h.AriaBusy(true)],
    }),
    Button.view(h, {
      variant,
      label: "Error",
      onClick: noop,
      attributes: [h.AriaInvalid(true)],
    }),
  ]
  return block(h, "Buttons", [
    panel(h, {
      children: [
        h.div(
          [h.Class("flex flex-col gap-3")],
          [
            ...variants.map((variant) =>
              h.div(
                [h.Class("flex flex-col gap-1.5")],
                [caption(h, variant), row(h, states(variant))],
              ),
            ),
            caption(h, "sizes"),
            row(h, [
              Button.view(h, {
                size: "xs",
                label: "Extra small",
                onClick: noop,
                variant: "secondary",
              }),
              Button.view(h, { size: "sm", label: "Small", onClick: noop, variant: "secondary" }),
              Button.view(h, { label: "Default", onClick: noop, variant: "secondary" }),
              Button.view(h, { size: "lg", label: "Large", onClick: noop, variant: "secondary" }),
              Button.view(h, {
                size: "icon",
                variant: "secondary",
                label: Icon.view(h, Pencil),
                onClick: noop,
                attributes: [h.AriaLabel("Edit")],
              }),
              Button.view(h, {
                size: "icon-sm",
                variant: "ghost",
                label: Icon.view(h, Plus),
                onClick: noop,
                attributes: [h.AriaLabel("Add")],
              }),
              Button.view(h, {
                label: h.span([h.Class("contents")], [Icon.view(h, Plus), "New rule"]),
                onClick: noop,
              }),
            ]),
          ],
        ),
      ],
    }),
  ])
}

const inputs = <M>(h: HtmlBuilder<M>, noop: M): Html =>
  block(h, "Inputs", [
    panel(h, {
      children: [
        h.div(
          [h.Class("grid max-w-2xl grid-cols-1 gap-3 sm:grid-cols-2")],
          [
            input(h, {
              id: "ds-input",
              label: "Default",
              placeholder: "Placeholder",
              onInput: () => noop,
            }),
            input(h, {
              id: "ds-input-value",
              label: "With value and help",
              value: "effect-ts/effect",
              description: "Repository names are machine values.",
              className: "font-mono",
              onInput: () => noop,
            }),
            input(h, {
              id: "ds-input-focus",
              label: "Focus",
              value: "Focused",
              className: cn(focusDemoClass, "border-primary bg-card"),
              onInput: () => noop,
            }),
            input(h, {
              id: "ds-input-disabled",
              label: "Disabled",
              value: "Disabled",
              isDisabled: true,
            }),
            input(h, {
              id: "ds-input-error",
              label: "Error",
              value: "not-a-repository",
              isInvalid: true,
              description: "Use owner/repository.",
              descriptionClass: "text-destructive",
              onInput: () => noop,
            }),
            Select.view(h, {
              id: "ds-select",
              label: "Select",
              value: "issues",
              options: [
                ["issues", "Issues"],
                ["pulls", "Pull requests"],
                ["both", "Issues and pull requests"],
              ],
              onChange: () => noop,
            }),
            h.div(
              [h.Class("flex flex-col gap-1.5")],
              [
                h.span([h.Class("text-label font-medium")], ["Input group"]),
                inputGroup(h, {
                  children: [
                    inputGroupAddon(h, { children: [Icon.view(h, Search)] }),
                    inputGroupInput(h, {
                      id: "ds-input-group",
                      ariaLabel: "Search rules",
                      placeholder: "Search rules",
                      onInput: () => noop,
                    }),
                  ],
                }),
              ],
            ),
            h.div(
              [h.Class("flex flex-col gap-1.5")],
              [
                h.span([h.Class("text-label font-medium")], ["Checkbox"]),
                h.label(
                  [h.Class("flex items-center gap-2 text-body-sm")],
                  [
                    h.input([
                      h.Type("checkbox"),
                      h.Class("size-3.5 accent-primary"),
                      h.Checked(true),
                    ]),
                    "Apply to pull requests",
                  ],
                ),
                h.label(
                  [h.Class("flex items-center gap-2 text-body-sm")],
                  [
                    h.input([h.Type("checkbox"), h.Class("size-3.5 accent-primary")]),
                    "Apply to issues",
                  ],
                ),
                h.label(
                  [h.Class("flex items-center gap-2 text-body-sm opacity-50")],
                  [
                    h.input([
                      h.Type("checkbox"),
                      h.Class("size-3.5 accent-primary"),
                      h.Disabled(true),
                    ]),
                    "Disabled",
                  ],
                ),
              ],
            ),
            h.div(
              [h.Class("sm:col-span-2")],
              [
                textarea(
                  {
                    id: "ds-textarea",
                    label: "Textarea",
                    placeholder: "Does this describe a bug?",
                    description: "Prompts are prose a human wrote, so they stay in Inter.",
                    onInput: () => noop,
                  },
                  h,
                ),
              ],
            ),
          ],
        ),
      ],
    }),
  ])

const switches = <M>(h: HtmlBuilder<M>, noop: M): Html =>
  block(h, "Switches", [
    panel(h, {
      children: [
        row(h, [
          Switch.view(h, {
            id: "ds-switch-off",
            label: "Off",
            isChecked: false,
            onToggle: () => noop,
          }),
          Switch.view(h, {
            id: "ds-switch-on",
            label: "On",
            isChecked: true,
            onToggle: () => noop,
          }),
          Switch.view(h, {
            id: "ds-switch-focus",
            label: "Focus",
            isChecked: true,
            onToggle: () => noop,
            attributes: [h.Class(focusDemoClass)],
          }),
          Switch.view(h, {
            id: "ds-switch-disabled",
            label: "Disabled",
            isChecked: false,
            isDisabled: true,
            onToggle: () => noop,
          }),
          Switch.view(h, {
            id: "ds-switch-busy",
            label: "Saving",
            isChecked: true,
            isDisabled: true,
            isBusy: true,
            onToggle: () => noop,
          }),
        ]),
      ],
    }),
  ])

const labelDot = <M>(h: HtmlBuilder<M>, color: string): Html =>
  h.span(
    [h.Class("size-1.5 rounded-full"), h.Style({ backgroundColor: color }), h.AriaHidden(true)],
    [],
  )

const badges = <M>(h: HtmlBuilder<M>): Html =>
  block(h, "Badges", [
    panel(h, {
      children: [
        row(h, [
          ...(Object.keys(chipVariants) as ReadonlyArray<ChipVariant>).map((variant) =>
            chip(h, { variant, children: [variant] }),
          ),
          chip(h, { children: [labelDot(h, "var(--oc-danger)"), "bug"] }),
          chip(h, { children: [labelDot(h, "var(--oc-success)"), "good first issue"] }),
          Feed.agentBadge(h),
          h.span([h.Class("oc-agent-badge")], ["written by The Janitor"]),
          platformMark(h, "github"),
          platformMark(h, "slack"),
          avatar(h, "maxwell.brown"),
        ]),
      ],
    }),
  ])

const cards = <M>(h: HtmlBuilder<M>, noop: M): Html =>
  block(h, "Cards and empty states", [
    panel(h, {
      flush: true,
      children: [
        panelHeader(h, {
          title: "Rules",
          meta: "rev 14 · 6 rules",
          actions: [
            Button.view(h, { size: "sm", variant: "secondary", label: "New rule", onClick: noop }),
          ],
        }),
        h.div([h.Class("p-4 text-body-md")], ["Card body at 16px padding. Cards do not nest."]),
      ],
    }),
    emptyPanel(h, {
      children: [
        h.div(
          [h.Class("flex items-center justify-between gap-3")],
          [
            h.span([], ["No rules yet. Create one to start labeling."]),
            Button.view(h, { size: "sm", label: "New rule", onClick: noop }),
          ],
        ),
      ],
    }),
    panel(h, {
      attributes: [h.Role("alert")],
      className: "border-destructive text-body-sm",
      children: [
        h.div([h.Class("font-medium text-destructive")], ["Sync failed"]),
        h.div([h.Class("text-ink-muted")], ["GitHub returned 502 for 2 scopes. Retry the sync."]),
      ],
    }),
    panel(h, {
      className: "flex flex-col gap-2",
      children: [
        caption(h, "loading: static blocks"),
        skeleton(h, { className: "h-3 w-1/2", children: [] }),
        skeleton(h, { className: "h-3 w-1/3", children: [] }),
      ],
    }),
  ])

const ruleNames = [
  "needs-triage",
  "bug",
  "docs",
  "area/schema",
  "area/platform",
  "good first issue",
  "breaking-change",
  "regression",
]

const denseTable = <M>(h: HtmlBuilder<M>, noop: M): Html =>
  block(h, "Dense table (200 rows)", [
    panel(h, {
      flush: true,
      children: [
        panelHeader(h, { title: "Labeling rules", meta: "200 rows · rev 14" }),
        h.div(
          [h.Class("max-h-96 overflow-auto")],
          [
            Table.table(h, {
              children: [
                Table.head(h, [
                  Table.row(h, {
                    children: [
                      Table.headCell(h, { children: ["Rule"] }),
                      Table.headCell(h, { children: ["Type"] }),
                      Table.headCell(h, { children: ["Label"] }),
                      Table.headCell(h, { numeric: true, children: ["Runs"] }),
                      Table.headCell(h, { numeric: true, children: ["Matches"] }),
                      Table.headCell(h, { children: ["Last run"] }),
                      Table.headCell(h, { children: ["Enabled"] }),
                    ],
                  }),
                ]),
                Table.body(
                  h,
                  Array.from({ length: 200 }, (_, index) => {
                    const name = ruleNames[index % ruleNames.length] ?? "rule"
                    const ai = index % 5 === 2
                    return Table.row(h, {
                      isSelected: index === 3,
                      children: [
                        Table.cell(h, { code: true, children: [`${name}-${index + 1}`] }),
                        Table.cell(h, {
                          children: [
                            ai
                              ? chip(h, { variant: "agent", children: ["AI"] })
                              : chip(h, { children: ["policy"] }),
                          ],
                        }),
                        Table.cell(h, { children: [chip(h, { children: [name] })] }),
                        Table.cell(h, { numeric: true, children: [String((index * 37) % 1204)] }),
                        Table.cell(h, { numeric: true, children: [String((index * 7) % 89)] }),
                        Table.cell(h, {
                          code: true,
                          children: [
                            `2026-09-1${index % 4} 12:${String(index % 60).padStart(2, "0")}`,
                          ],
                        }),
                        Table.cell(h, {
                          children: [
                            Switch.view(h, {
                              id: `ds-row-switch-${index}`,
                              label: `Enable ${name}`,
                              isLabelHidden: true,
                              isChecked: index % 3 !== 0,
                              onToggle: () => noop,
                            }),
                          ],
                        }),
                      ],
                    })
                  }),
                ),
              ],
            }),
          ],
        ),
      ],
    }),
  ])

const tabs = <M>(h: HtmlBuilder<M>): Html =>
  block(h, "Tabs", [
    h.div(
      [h.DataAttribute("slot", "tabs-list"), h.Role("tablist")],
      [
        h.button(
          [
            h.Type("button"),
            h.Role("tab"),
            h.DataAttribute("slot", "tabs-trigger"),
            h.DataAttribute("state", "active"),
            h.AriaSelected(true),
          ],
          ["Overview"],
        ),
        h.button(
          [
            h.Type("button"),
            h.Role("tab"),
            h.DataAttribute("slot", "tabs-trigger"),
            h.AriaSelected(false),
          ],
          ["Policies"],
        ),
        h.button(
          [
            h.Type("button"),
            h.Role("tab"),
            h.DataAttribute("slot", "tabs-trigger"),
            h.AriaSelected(false),
            h.Class(focusDemoClass),
          ],
          ["Rules"],
        ),
        h.button(
          [
            h.Type("button"),
            h.Role("tab"),
            h.DataAttribute("slot", "tabs-trigger"),
            h.AriaSelected(false),
            h.Disabled(true),
            h.Class("opacity-50"),
          ],
          ["Activity"],
        ),
      ],
    ),
  ])

const overlays = <M>(h: HtmlBuilder<M>, noop: M): Html =>
  block(h, "Overlays (the only shadowed elements)", [
    h.div(
      [h.Class("grid grid-cols-1 gap-3 lg:grid-cols-2")],
      [
        h.div(
          [
            h.Class(cn(Dialog.dialogContentClass, "mx-0 mt-0 w-full")),
            h.Role("dialog"),
            h.AriaLabel("Delete rule?"),
          ],
          [
            h.h2([h.Class(Dialog.dialogTitleClass)], ["Delete rule?"]),
            h.p(
              [h.Class(Dialog.dialogDescriptionClass)],
              ['Delete "needs-triage"? This cannot be undone.'],
            ),
            h.div(
              [h.Class(Dialog.dialogActionsClass)],
              [
                Button.view(h, { variant: "secondary", label: "Cancel", onClick: noop }),
                Button.view(h, { variant: "destructive", label: "Delete rule", onClick: noop }),
              ],
            ),
          ],
        ),
        h.div(
          [h.Class("flex flex-col gap-3")],
          [
            h.div(
              [h.Class(Overlay.menuItemsClass), h.Role("menu")],
              [
                h.div(
                  [
                    h.Class(cn(Overlay.menuItemClass, Overlay.menuItemActiveClass)),
                    h.Role("menuitem"),
                  ],
                  [Icon.view(h, Pencil), "Edit rule"],
                ),
                h.div(
                  [h.Class(Overlay.menuItemClass), h.Role("menuitem")],
                  [Icon.view(h, Check), "Enable"],
                ),
                h.div(
                  [h.Class(cn(Overlay.menuItemClass, "text-destructive")), h.Role("menuitem")],
                  ["Delete"],
                ),
              ],
            ),
            h.div(
              [h.Class(Overlay.tooltipContentClass), h.Role("tooltip")],
              ["Re-sync GitHub · last verified 3 minutes ago"],
            ),
            h.div(
              [h.Class(Overlay.toastClass), h.Role("status")],
              [
                h.div([h.Class(Overlay.toastTitleClass)], ["Paused"]),
                h.div(
                  [h.Class(Overlay.toastDescriptionClass)],
                  ["Automation is paused for effect-ts/effect."],
                ),
              ],
            ),
            h.div(
              [h.Class(cn(Overlay.toastClass, "border-destructive")), h.Role("alert")],
              [
                h.div([h.Class(Overlay.toastTitleClass)], ["Sync request failed"]),
                h.div(
                  [h.Class(Overlay.toastDescriptionClass)],
                  ["GitHub did not accept the request. Retry."],
                ),
              ],
            ),
          ],
        ),
      ],
    ),
  ])

const feed = <M>(h: HtmlBuilder<M>): Html =>
  block(h, "Activity feed", [
    panel(h, {
      flush: true,
      children: [
        Feed.item(h, {
          actor: { kind: "agent" },
          timestamp: "12:04:31",
          body: [
            "added ",
            chip(h, { children: ["bug"] }),
            " to ",
            h.a([h.Href("#"), h.Class("font-mono")], ["#4821"]),
            " after rule ",
            h.code([h.Class("text-mono-sm")], ["needs-triage"]),
            " matched.",
          ],
        }),
        Feed.item(h, {
          actor: { kind: "agent" },
          timestamp: "12:04:29",
          body: [
            "classified ",
            h.a([h.Href("#"), h.Class("font-mono")], ["#4821"]),
            " as a bug at 0.91 confidence: ",
            h.span(
              [h.Class("text-ink-muted")],
              ["“The report includes a stack trace and a reproducible failing case.”"],
            ),
          ],
        }),
        Feed.item(h, {
          actor: { kind: "human", name: "mikearnaldi" },
          timestamp: "11:58:02",
          body: [
            "opened ",
            h.a([h.Href("#"), h.Class("font-mono")], ["#4821"]),
            " Schema.decodeUnknown panics on circular input",
          ],
        }),
        Feed.item(h, {
          actor: { kind: "agent" },
          timestamp: "11:40:00",
          body: [
            "could not add ",
            chip(h, { children: ["area/schema"] }),
            " to ",
            h.a([h.Href("#"), h.Class("font-mono")], ["#4819"]),
            ": ",
            h.span([h.Class("text-destructive")], ["GitHub returned 403."]),
          ],
        }),
      ],
    }),
  ])

const inspector = <M>(h: HtmlBuilder<M>): Html =>
  block(h, "Inspector", [
    panel(h, {
      flush: true,
      className: "max-w-inspector",
      children: [
        Inspector.section(h, {
          heading: "Selection",
          children: [
            Inspector.row(h, "Rule", "needs-triage"),
            Inspector.row(h, "Kind", "policy"),
            Inspector.row(h, "Label", "needs-triage"),
            Inspector.row(h, "Revision", "14"),
          ],
        }),
        Inspector.section(h, {
          heading: "Dry run",
          children: [
            Inspector.proseRow(h, "Result", "Would add the label to 12 of 40 open issues."),
          ],
        }),
        Inspector.section(h, {
          heading: "History",
          children: [
            h.p([h.Class("text-body-sm text-ink-muted")], ["Select a row to see its history."]),
          ],
        }),
      ],
    }),
  ])

const blueprint = <M>(h: HtmlBuilder<M>): Html =>
  block(h, "Blueprint canvas (graph views only)", [
    panel(h, {
      flush: true,
      children: [
        panelHeader(h, { title: "needs-triage", meta: "rule · rev 14" }),
        Blueprint.canvas(h, {
          children: [
            Blueprint.column(h, {
              label: "When",
              children: [Blueprint.node(h, { kind: "Issue opened", children: ["issues.opened"] })],
            }),
            Blueprint.wire(h, { label: "and" }),
            Blueprint.column(h, {
              label: "If every condition matches",
              children: [
                Blueprint.node(h, {
                  kind: "Policy",
                  isSelected: true,
                  children: ["no-triage-label"],
                }),
                Blueprint.node(h, {
                  kind: "Classification",
                  isAgent: true,
                  children: ["Does this describe a bug? ≥ 0.80"],
                }),
              ],
            }),
            Blueprint.wire(h, { height: 96, fromY: 48, toY: 24 }),
            Blueprint.column(h, {
              label: "Then",
              children: [
                Blueprint.node(h, { kind: "Add label", children: ["needs-triage"] }),
                Blueprint.annotation(h, [
                  "Runs only when the gate policy matches; otherwise labels stay unchanged.",
                ]),
              ],
            }),
          ],
        }),
        Blueprint.footer(h, {
          summary: "1 trigger · 2 conditions · 1 action",
          counts: "3 nodes · 2 wires",
        }),
      ],
    }),
  ])

const navigation = <M>(h: HtmlBuilder<M>): Html =>
  block(h, "Section navigation", [
    panel(h, {
      className: "max-w-56",
      children: [
        rack(h, {
          label: "Account sections",
          items: [
            { href: "#", label: "You", isCurrent: false },
            { href: "#", label: "Connected accounts", isCurrent: true },
            { href: "#", label: "Team", isCurrent: false },
            { href: "#", label: "Danger zone", isCurrent: false, variant: "danger" },
          ],
        }),
      ],
    }),
  ])

const sections = <M>(h: HtmlBuilder<M>, noop: M): ReadonlyArray<Html> => [
  typography(h),
  colors(h),
  buttons(h, noop),
  inputs(h, noop),
  switches(h, noop),
  badges(h),
  cards(h, noop),
  tabs(h),
  denseTable(h, noop),
  overlays(h, noop),
  feed(h),
  inspector(h),
  blueprint(h),
  navigation(h),
]

export const view = <M>(h: HtmlBuilder<M>, inputs: ViewInputs<M>): Html =>
  h.div(
    [h.Class("flex flex-col gap-6 p-4 lg:p-5")],
    [
      h.div(
        [h.Class("flex flex-col gap-1")],
        [
          h.h1([], ["Design system"]),
          h.p(
            [h.Class("text-body-sm text-ink-muted")],
            [
              "Every primitive in every state. Light first, then the same set inside a dark container.",
            ],
          ),
        ],
      ),
      ...sections(h, inputs.noop),
      h.div(
        [
          h.Class(
            "dark flex flex-col gap-6 rounded-sm border border-border bg-background p-4 text-foreground",
          ),
        ],
        [h.h2([], ["Dark"]), ...sections(h, inputs.noop)],
      ),
    ],
  )
