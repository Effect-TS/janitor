import { describeResultAction } from "@janitor/domain/Labeling/Policy/Plan"
import * as Render from "foldkit/render"
import * as VirtualList from "@foldkit/ui/virtualList"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpIncomingMessage from "effect/unstable/http/HttpIncomingMessage"
import * as Command from "foldkit/command"
import { defineMessageUnion } from "foldkit/message"
import * as Submodel from "foldkit/submodel"
import * as Subscription from "foldkit/subscription"
import * as Update from "foldkit/update"
import type { Html, HtmlBuilder } from "foldkit/html"
import {
  ActivityCursor,
  ActivityEntry,
  ActivityPage,
  type RepositoryOverview,
  type ConfigurationView,
} from "./labeling-wire"
import * as Button from "./ui/button"
import { chip } from "./ui/chip"
import * as Feed from "./ui/feed"
import { inputGroup, inputGroupAddon, inputGroupInput } from "./ui/input-group"
import { emptyPanel } from "./ui/panel"
import * as Select from "./ui/select"
import * as Icon from "@/lib/icons"
import { cn } from "@/lib/utils"
import { Check, ChevronDown, ChevronRight, CircleAlert, CircleHelp, Clock, Search } from "lucide"
import * as Routes from "@/routes"

const Mode = Schema.Literals(["journal", "grouped"])
const Target = Schema.Literals(["all", "issue", "pull_request"])
export const MAX_LOADED = 2000
export const Model = Schema.Struct({
  repositoryId: Schema.String,
  active: Schema.Boolean,
  mode: Mode,
  search: Schema.String,
  target: Target,
  entries: Schema.Array(ActivityEntry),
  cursor: Schema.NullOr(ActivityCursor),
  pending: Schema.NullOr(ActivityPage),
  searchPending: Schema.Boolean,
  loadingOlder: Schema.Boolean,
  loading: Schema.Boolean,
  initialized: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  generation: Schema.Int,
  expanded: Schema.Array(Schema.String),
  expandedGroups: Schema.Array(Schema.Int),
  journal: VirtualList.Model,
  grouped: VirtualList.Model,
})
export type Model = typeof Model.Type
export const Message = defineMessageUnion({
  Activated: { repositoryId: Schema.String, active: Schema.Boolean },
  ChangedMode: { mode: Mode },
  ChangedSearch: { value: Schema.String },
  ChangedTarget: { target: Target },
  SettledSearch: { generation: Schema.Int },
  Polled: {},
  ClickedMore: {},
  ClickedRetry: {},
  ClickedNew: {},
  Loaded: { generation: Schema.Int, older: Schema.Boolean, page: ActivityPage },
  Failed: { generation: Schema.Int, reason: Schema.String },
  ToggledEvent: { id: Schema.String },
  ToggledGroup: { number: Schema.Int },
  GotList: { mode: Mode, message: VirtualList.Message },
})
export type Message = typeof Message.Type
export const init = (): Model => ({
  repositoryId: "",
  active: false,
  mode: "grouped",
  search: "",
  target: "all",
  entries: [],
  cursor: null,
  pending: null,
  searchPending: false,
  loadingOlder: false,
  loading: false,
  initialized: false,
  error: null,
  generation: 0,
  expanded: [],
  expandedGroups: [],
  journal: VirtualList.init({ id: "activity-journal", rowHeightPx: 32 }),
  grouped: VirtualList.init({ id: "activity-grouped", rowHeightPx: 32 }),
})
export const FetchPage = Command.define("FetchActivity", {
  args: {
    repositoryId: Schema.String,
    generation: Schema.Int,
    search: Schema.String,
    target: Target,
    cursor: Schema.NullOr(ActivityCursor),
  },
  messages: [Message.Loaded, Message.Failed],
  execute: ({ repositoryId, generation, search, target, cursor }) =>
    Effect.gen(function* () {
      const params = new URLSearchParams({ search, target })
      if (cursor) params.set("cursor", JSON.stringify(cursor))
      const response = yield* HttpClient.get(
        `/api/v1/repositories/${encodeURIComponent(repositoryId)}/activity?${params}`,
      )
      if (response.status !== 200)
        return Message.Failed({
          generation,
          reason:
            response.status === 404
              ? "This repository is unavailable."
              : "Activity could not be loaded. Try again.",
        })
      const page = yield* HttpIncomingMessage.schemaBodyJson(ActivityPage)(response)
      return Message.Loaded({ generation, older: cursor !== null, page })
    }).pipe(
      Effect.timeout("15 seconds"),
      Effect.catch(() =>
        Effect.succeed(
          Message.Failed({
            generation,
            reason: "Activity could not be loaded. Check your connection and try again.",
          }),
        ),
      ),
    ),
})
type Return = Update.Return<Model, Message, HttpClient.HttpClient>
const fetchPage = (model: Model, older = false): Return => {
  if (
    !model.active ||
    model.loading ||
    (older && (!model.cursor || model.entries.length >= MAX_LOADED))
  )
    return { model }
  return {
    model: { ...model, loading: true, loadingOlder: older, error: null },
    commands: [
      FetchPage({
        repositoryId: model.repositoryId,
        generation: model.generation,
        search: model.search.trim(),
        target: model.target,
        cursor: older ? model.cursor : null,
      }),
    ],
  }
}
const reset = (model: Model): Model => ({
  ...model,
  entries: [],
  pending: null,
  cursor: null,
  expanded: [],
  expandedGroups: [],
  searchPending: false,
  loading: false,
  initialized: false,
  error: null,
  generation: model.generation + 1,
  journal: init().journal,
  grouped: init().grouped,
})
export type Row =
  | { kind: "group"; number: number; title: string; count: number }
  | { kind: "event"; entry: ActivityEntry; expanded: boolean }
export const rows = (model: Model): ReadonlyArray<Row> => {
  const event = (entry: ActivityEntry): Row => ({
    kind: "event",
    entry,
    expanded: model.expanded.includes(entry.id),
  })
  if (model.mode === "journal") return model.entries.map(event)
  const groups = new Map<number, ActivityEntry[]>()
  for (const entry of model.entries) {
    const group = groups.get(entry.number)
    if (group) group.push(entry)
    else groups.set(entry.number, [entry])
  }
  return [...groups].flatMap(([number, entries]): Row[] => [
    {
      kind: "group",
      number,
      title: entries[0]!.title ?? `Subject #${number}`,
      count: entries.length,
    },
    ...(model.expandedGroups.includes(number) ? entries.map(event) : []),
  ])
}
export const rowHeight = (row: Row) => (row.kind === "group" ? 28 : row.expanded ? 420 : 32)
const scrollTop = (model: Model): Return => {
  const result = VirtualList.scrollToIndexVariable(model[model.mode], rows(model), rowHeight, 0)
  return {
    model: { ...model, [model.mode]: result.model },
    commands: Command.mapMessages(
      (result.commands ?? []).map((command) =>
        Command.mapEffect(command, (effect) => Effect.andThen(Render.afterPaint, effect)),
      ),
      (message) => Message.GotList({ mode: model.mode, message }),
    ),
  }
}
export const update = (model: Model, message: Message): Return =>
  Message.match(message, {
    Activated: ({ repositoryId, active }) => {
      if (model.repositoryId === repositoryId && model.active === active) return { model }
      const next =
        repositoryId === model.repositoryId
          ? { ...model, active }
          : { ...reset(model), repositoryId, active }
      // Fence responses when leaving and refresh on return; keep each view's position.
      return active
        ? fetchPage({
            ...next,
            loading: false,
            generation: next.generation + 1,
            journal: { ...next.journal, measurement: { _tag: "Unmeasured" } },
            grouped: { ...next.grouped, measurement: { _tag: "Unmeasured" } },
          })
        : { model: { ...next, loading: false, generation: next.generation + 1 } }
    },
    ChangedMode: ({ mode }) =>
      mode === model.mode
        ? { model }
        : {
            model: {
              ...model,
              mode,
              [mode]: { ...model[mode], measurement: { _tag: "Unmeasured" } },
            },
          },
    ChangedSearch: ({ value }) => ({
      model: { ...reset({ ...model, search: value.slice(0, 200) }), searchPending: true },
    }),
    SettledSearch: ({ generation }) =>
      generation === model.generation ? fetchPage({ ...model, searchPending: false }) : { model },
    ChangedTarget: ({ target }) => fetchPage(reset({ ...model, target })),
    Polled: () => (model.error || model.searchPending ? { model } : fetchPage(model)),
    ClickedMore: () => fetchPage(model, true),
    ClickedRetry: () => fetchPage(model, model.loadingOlder),
    Loaded: ({ generation, older, page }) => {
      if (generation !== model.generation || !model.active) return { model }
      const next = { ...model, loading: false, initialized: true, error: null }
      if (older) {
        const known = new Set(model.entries.map((entry) => entry.id))
        return {
          model: {
            ...next,
            entries: [
              ...model.entries,
              ...page.entries.filter((entry) => !known.has(entry.id)),
            ].slice(0, MAX_LOADED),
            cursor: page.cursor,
          },
        }
      }
      if (!model.initialized)
        return { model: { ...next, entries: page.entries, cursor: page.cursor } }
      const fresh = new Map(page.entries.map((entry) => [entry.id, entry]))
      const entries = model.entries.map((entry) => fresh.get(entry.id) ?? entry)
      return {
        model: {
          ...next,
          entries,
          pending: page.entries.some((entry) => !model.entries.some((old) => old.id === entry.id))
            ? page
            : null,
        },
      }
    },
    Failed: ({ generation, reason }) =>
      generation !== model.generation
        ? { model }
        : { model: { ...model, loading: false, error: reason } },
    ClickedNew: () =>
      model.pending
        ? scrollTop({
            ...model,
            entries: model.pending.entries,
            cursor: model.pending.cursor,
            pending: null,
            expanded: [],
            expandedGroups: [],
          })
        : { model },
    ToggledEvent: ({ id }) => ({
      model: {
        ...model,
        expanded: model.expanded.includes(id)
          ? model.expanded.filter((value) => value !== id)
          : [...model.expanded, id],
      },
    }),
    ToggledGroup: ({ number }) => ({
      model: {
        ...model,
        expandedGroups: model.expandedGroups.includes(number)
          ? model.expandedGroups.filter((value) => value !== number)
          : [...model.expandedGroups, number],
      },
    }),
    GotList: ({ mode, message }) => {
      const result = VirtualList.update(model[mode], message)
      return {
        model: { ...model, [mode]: result.model },
        // Restore scroll after the newly mounted list has rendered its spacer rows.
        commands: Command.mapMessages(
          (result.commands ?? []).map((command) =>
            Command.mapEffect(command, (effect) => Effect.andThen(Render.afterPaint, effect)),
          ),
          (message) => Message.GotList({ mode, message }),
        ),
      }
    },
  })
const listSubscriptions = (mode: typeof Mode.Type) =>
  Subscription.lift(VirtualList.subscriptions)<Model, Message>({
    toChildModel: (model) => model[mode],
    toParentMessage: (message) => Message.GotList({ mode, message }),
  })
const searchChanges = Subscription.make<Model, Message>()((entry) => ({
  searchDebounce: entry(
    { pending: Schema.Boolean, generation: Schema.Int },
    {
      modelToDependencies: (model) => ({
        pending: model.active && model.searchPending,
        generation: model.generation,
      }),
      dependenciesToStream: ({ pending, generation }) =>
        pending
          ? Stream.fromEffect(
              Effect.sleep("300 millis").pipe(Effect.as(Message.SettledSearch({ generation }))),
            )
          : Stream.empty,
    },
  ),
}))
export const subscriptions = Subscription.aggregate<Model, Message>()(
  { journalEvents: listSubscriptions("journal").containerEvents },
  { groupedEvents: listSubscriptions("grouped").containerEvents },
  searchChanges,
)
export const outcome = (
  entry: ActivityEntry,
): { label: string; tone: string; icon: typeof Check } => {
  const evaluationFailed =
    entry.outcome === "failed" ||
    entry.plan?.rules.some((rule) => rule.outcome === "failed") ||
    entry.evaluations?.some((rule) => rule.outcome === "failed")
  if (entry.actions.some((action) => action.status === "failed"))
    return {
      label: evaluationFailed ? "Evaluation and label update failed" : "Label update failed",
      tone: "text-destructive",
      icon: CircleAlert,
    }
  if (evaluationFailed)
    return {
      label: entry.actions.some((action) => action.status === "applied")
        ? "Labels updated · evaluation failed"
        : entry.actions.some((action) => action.status === "planned")
          ? "Evaluation failed · label updates pending"
          : "Evaluation failed · labels unchanged",
      tone: "text-destructive",
      icon: CircleAlert,
    }
  if (!entry.outcome || entry.actions.some((action) => action.status === "planned"))
    return { label: "Pending", tone: "text-ink-muted", icon: Clock }
  if (entry.outcome === "superseded")
    return { label: "Replaced by newer activity", tone: "text-ink-muted", icon: Clock }
  if (entry.outcome === "not-qualified")
    return { label: "Waiting for a verified snapshot", tone: "text-ink-muted", icon: Clock }
  if (entry.actions.some((action) => action.status === "applied"))
    return { label: "Labels updated", tone: "text-foreground", icon: Check }
  if (entry.evaluations?.some((rule) => rule.reason.startsWith("Gate unresolved:")))
    return { label: "Gate unresolved · AI skipped", tone: "text-ink-muted", icon: CircleHelp }
  if (entry.plan?.rules.some((rule) => rule.outcome === "unknown"))
    return {
      label: "Could not decide · labels unchanged",
      tone: "text-ink-muted",
      icon: CircleHelp,
    }
  return { label: "No label changes", tone: "text-ink-muted", icon: Check }
}
const stamp = (entry: ActivityEntry) =>
  DateTime.formatUtc(entry.createdAt, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }) + " UTC"
const isHex = (color: string | null | undefined): color is string =>
  color !== null && color !== undefined && /^[0-9a-f]{6}$/i.test(color)
/** GitHub label colour as a 6px dot inside a neutral chip; never a fill. */
const labelDot = (h: HtmlBuilder<Message>, color: string | null | undefined) =>
  h.span(
    [
      h.Class(cn("size-1.5 rounded-full", isHex(color) ? "" : "bg-ink-faint")),
      ...(isHex(color) ? [h.Style({ backgroundColor: `#${color}` })] : []),
      h.AriaHidden(true),
    ],
    [],
  )
const label = (h: HtmlBuilder<Message>, action: ActivityEntry["actions"][number]) =>
  chip(h, { children: [labelDot(h, action.color), action.name ?? `Label ${action.labelId}`] })
const subjectRef = (h: HtmlBuilder<Message>, entry: ActivityEntry) =>
  h.span([h.Class("font-mono text-primary")], [`#${entry.number}`])
/** One feed line: what The Janitor did to the subject. */
const feedBody = (h: HtmlBuilder<Message>, entry: ActivityEntry): ReadonlyArray<Html | string> => {
  const subject: ReadonlyArray<Html | string> = [
    subjectRef(h, entry),
    ...(entry.title ? [" (", entry.title, ")"] : []),
  ]
  const list = (actions: ReadonlyArray<ActivityEntry["actions"][number]>) =>
    actions.flatMap((action, index) => [index === 0 ? "" : " ", label(h, action)])
  const applied = entry.actions.filter((action) => action.status === "applied")
  const failed = entry.actions.filter((action) => action.status === "failed")
  const planned = entry.actions.filter((action) => action.status === "planned")
  if (applied.length > 0) {
    const added = applied.filter((action) => action.action === "add")
    const removed = applied.filter((action) => action.action === "remove")
    return [
      ...(added.length > 0 ? ["added ", ...list(added)] : []),
      ...(added.length > 0 && removed.length > 0 ? [" and "] : []),
      ...(removed.length > 0 ? ["removed ", ...list(removed)] : []),
      ...(failed.length > 0 ? [", could not update ", ...list(failed)] : []),
      " on ",
      ...subject,
    ]
  }
  if (failed.length > 0) return ["could not update ", ...list(failed), " on ", ...subject]
  if (planned.length > 0) return ["is updating ", ...list(planned), " on ", ...subject]
  return ["evaluated ", ...subject]
}
const decisionChip = (
  h: HtmlBuilder<Message>,
  result: string | undefined,
  skipped: boolean | undefined,
) => {
  const status = skipped
    ? "Skipped by gate"
    : result === "match"
      ? "Matched"
      : result === "no-match"
        ? "No match"
        : result === "failed"
          ? "Evaluation failed"
          : result === "unknown"
            ? "Undecided"
            : "Pending"
  const icon = skipped
    ? null
    : result === "match"
      ? Check
      : result === "unknown"
        ? CircleHelp
        : result === "failed"
          ? CircleAlert
          : result === "no-match"
            ? null
            : Clock
  return chip(h, {
    variant: result === "failed" && !skipped ? "danger" : "neutral",
    className: "shrink-0",
    children: [...(icon ? [Icon.view(h, icon, "size-3 shrink-0")] : []), status],
  })
}
const evaluationCards = (
  h: HtmlBuilder<Message>,
  model: Model,
  entry: ActivityEntry,
  configuration: ConfigurationView | undefined,
) => {
  const ids = [
    ...new Set([
      ...(entry.plan?.rules.map((rule) => rule.ruleId) ?? []),
      ...(entry.evaluations?.map((rule) => rule.ruleId) ?? []),
      ...entry.actions.map((action) => action.ruleId),
    ]),
  ]
  return ids.map((id) => {
    const decision = entry.plan?.rules.find((rule) => rule.ruleId === id)
    const evaluation = entry.evaluations?.find((rule) => rule.ruleId === id)
    const actions = entry.actions.filter((action) => action.ruleId === id)
    const rule = configuration?.rules.find((rule) => rule.id === id)
    const currentLabel = configuration?.labels.find((label) => label.labelId === rule?.labelId)
    const name =
      currentLabel?.name ?? actions.find((action) => action.name)?.name ?? `Rule ${id.slice(0, 8)}`
    const color = currentLabel?.color ?? actions.find((action) => action.color)?.color
    const skipped = evaluation?.reason.startsWith("Skipped by gate:")
    const result = decision?.outcome ?? evaluation?.outcome
    return h.div(
      [h.Class("flex min-w-0 flex-col gap-2 py-2.5"), h.DataAttribute("rule", id)],
      [
        h.div(
          [h.Class("flex flex-wrap items-center gap-2")],
          [
            h.a(
              [
                h.Href(Routes.rule({ repositoryId: model.repositoryId, ruleId: id })),
                h.Class(
                  "inline-flex min-w-0 max-w-full items-center gap-1.5 font-mono text-mono-sm text-primary hover:underline",
                ),
              ],
              [labelDot(h, color), h.span([h.Class("truncate")], [name])],
            ),
            rule
              ? rule.ai
                ? chip(h, { variant: "agent", children: ["AI"] })
                : chip(h, { children: ["policy"] })
              : h.empty,
            h.span([h.Class("ml-auto")], [decisionChip(h, result, skipped)]),
          ],
        ),
        rule?.ai && !skipped && evaluation?.reason
          ? h.div(
              [h.Class("oc-agent-edge flex flex-col items-start gap-1 pl-2.5")],
              [
                Feed.agentBadge(h, "AI"),
                h.p(
                  [h.Class("max-w-prose text-body-sm text-ink-muted wrap-anywhere")],
                  [evaluation.reason],
                ),
              ],
            )
          : h.empty,
        decision?.requestedAction
          ? h.p(
              [h.Class("text-body-sm text-ink-muted")],
              [describeResultAction(decision.requestedAction)],
            )
          : h.empty,
        decision?.selected
          ? h.p([h.Class("text-body-sm text-ink-muted")], ["Selected for the label plan"])
          : h.empty,
        ...actions.map((action) =>
          h.div(
            [
              h.Class(
                cn(
                  "flex flex-wrap items-center gap-1.5 text-body-sm",
                  action.status === "failed" ? "text-destructive" : "text-ink-muted",
                ),
              ),
            ],
            [
              Icon.view(
                h,
                action.status === "failed"
                  ? CircleAlert
                  : action.status === "applied"
                    ? Check
                    : Clock,
                "size-3 shrink-0",
              ),
              h.span(
                [],
                [
                  action.status === "applied"
                    ? action.action === "add"
                      ? "Label added"
                      : "Label removed"
                    : action.status === "failed"
                      ? action.action === "add"
                        ? "Could not add label"
                        : "Could not remove label"
                      : action.action === "add"
                        ? "Waiting to add label"
                        : "Waiting to remove label",
                ],
              ),
              label(h, action),
              ...(action.detail
                ? [h.p([h.Class("basis-full text-ink-muted")], [action.detail])]
                : []),
            ],
          ),
        ),
      ],
    )
  })
}
const eventView = (
  h: HtmlBuilder<Message>,
  model: Model,
  entry: ActivityEntry,
  expanded: boolean,
  repository: RepositoryOverview | undefined,
  configuration: ConfigurationView | undefined,
) => {
  const result = outcome(entry)
  return h.article(
    [h.Class("h-full border-b border-border-subtle"), h.DataAttribute("slot", "feed-item")],
    [
      h.button(
        [
          h.Class(
            "activity-event-summary flex h-8 w-full cursor-pointer items-center gap-2.5 px-3 text-left text-body-md transition-colors duration-120 ease-ui hover:bg-surface-muted",
          ),
          h.OnClick(Message.ToggledEvent({ id: entry.id })),
          h.AriaExpanded(expanded),
        ],
        [
          Feed.marker(h, { kind: "agent" }),
          h.span(
            [h.Class("min-w-0 flex-1 truncate")],
            [Feed.actorName(h, { kind: "agent" }), " ", ...feedBody(h, entry)],
          ),
          h.span(
            [
              h.Class(
                cn("hidden shrink-0 items-center gap-1 text-body-sm sm:inline-flex", result.tone),
              ),
            ],
            [Icon.view(h, result.icon, "size-3 shrink-0"), result.label],
          ),
          h.time(
            [h.Class("shrink-0 font-mono text-mono-xs text-ink-subtle tabular-nums")],
            [stamp(entry)],
          ),
          Icon.view(h, expanded ? ChevronDown : ChevronRight, "size-3.5 shrink-0 text-ink-subtle"),
        ],
      ),
      expanded
        ? h.div(
            [
              h.Class("activity-event-details"),
              h.Tabindex(0),
              h.AriaLabel(`Evaluation details for #${entry.number}`),
            ],
            [
              h.div(
                [h.Class("flex items-center justify-between gap-3")],
                [
                  h.h3(
                    [h.Class("text-caption font-medium text-ink-subtle")],
                    ["Evaluation details"],
                  ),
                  repository && entry.kind
                    ? h.a(
                        [
                          h.Href(
                            `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/${entry.kind === "issue" ? "issues" : "pull"}/${entry.number}`,
                          ),
                          h.Target("_blank"),
                          h.Rel("noopener noreferrer"),
                          h.Class("text-body-sm text-primary hover:underline"),
                        ],
                        ["Open on GitHub"],
                      )
                    : h.empty,
                ],
              ),
              entry.detail
                ? h.p(
                    [h.Class("mt-2 text-body-sm text-ink-muted whitespace-pre-wrap")],
                    [entry.detail],
                  )
                : h.empty,
              h.div(
                [
                  h.Class(
                    cn(
                      "mt-2 flex flex-wrap items-center gap-2 rounded-xs bg-surface-muted px-2.5 py-1.5 text-body-sm",
                      result.tone,
                    ),
                  ),
                ],
                [
                  Icon.view(h, result.icon, "size-3.5 shrink-0"),
                  h.span([], [result.label]),
                  h.span(
                    [h.Class("ml-auto font-mono text-mono-xs text-ink-subtle tabular-nums")],
                    [`${entry.plan?.rules.length ?? entry.evaluations?.length ?? 0} rules`],
                  ),
                ],
              ),
              h.div(
                [h.Class("flex flex-col divide-y divide-border-subtle")],
                evaluationCards(h, model, entry, configuration),
              ),
              h.p(
                [h.Class("mt-2 text-caption text-ink-subtle")],
                [
                  "Rules revision ",
                  h.span([h.Class("font-mono tabular-nums")], [String(entry.revision)]),
                  " · Rule names and types reflect current configuration.",
                ],
              ),
            ],
          )
        : h.empty,
    ],
  )
}
const groupView = (h: HtmlBuilder<Message>, model: Model, row: Row & { kind: "group" }) => {
  const expanded = model.expandedGroups.includes(row.number)
  return h.button(
    [
      h.Class(
        "flex h-7 w-full cursor-pointer items-center gap-2 border-b border-border-subtle bg-surface-muted px-3 text-left text-caption text-ink-subtle transition-colors duration-120 ease-ui",
      ),
      h.OnClick(Message.ToggledGroup({ number: row.number })),
      h.AriaExpanded(expanded),
    ],
    [
      Icon.view(h, expanded ? ChevronDown : ChevronRight, "size-3.5 shrink-0"),
      h.span([h.Class("shrink-0 font-mono text-mono-xs")], [`#${row.number}`]),
      h.span([h.Class("min-w-0 flex-1 truncate font-medium text-foreground")], [row.title]),
      h.span(
        [h.Class("shrink-0 font-mono text-mono-xs tabular-nums")],
        [`${row.count} ${row.count === 1 ? "evaluation" : "evaluations"}`],
      ),
    ],
  )
}
export const view = Submodel.defineView<
  Model,
  Message,
  { repository: RepositoryOverview | undefined; configuration?: ConfigurationView | undefined }
>((model, { repository, configuration }, h) => {
  const items = rows(model)
  const filtered = model.search || model.target !== "all"
  return h.section(
    [h.Class("activity-workspace"), h.AriaLabel("Repository activity")],
    [
      h.div(
        [h.Class("flex shrink-0 flex-wrap items-center gap-2 pb-3")],
        [
          h.form(
            [h.Class("w-full sm:w-72"), h.OnSubmit(Message.ChangedSearch({ value: model.search }))],
            [
              inputGroup(h, {
                children: [
                  inputGroupAddon(h, { children: [Icon.view(h, Search)] }),
                  inputGroupInput(h, {
                    id: "activity-search",
                    type: "search",
                    value: model.search,
                    placeholder: "Find an issue or pull request…",
                    ariaLabel: "Search activity",
                    onInput: (value) => Message.ChangedSearch({ value }),
                  }),
                ],
              }),
            ],
          ),
          h.div(
            [h.Class("flex items-center gap-1"), h.Role("group"), h.AriaLabel("Activity view")],
            (["journal", "grouped"] as const).map((mode) =>
              Button.view(h, {
                variant: "secondary",
                size: "sm",
                label: mode === "journal" ? "Journal" : "By subject",
                onClick: Message.ChangedMode({ mode }),
                className: model.mode === mode ? "bg-primary-wash" : undefined,
                attributes: [h.AriaPressed(String(model.mode === mode))],
              }),
            ),
          ),
          Select.view(h, {
            id: "activity-target",
            label: "Subject type",
            isLabelHidden: true,
            wrapperClass: "w-36",
            className: "h-6 text-body-sm",
            value: model.target,
            options: [
              ["all", "All subjects"],
              ["pull_request", "Pull requests"],
              ["issue", "Issues"],
            ],
            onChange: (value) =>
              Message.ChangedTarget({
                target:
                  value === "issue" ? "issue" : value === "pull_request" ? "pull_request" : "all",
              }),
          }),
          model.pending
            ? Button.view(h, {
                label: "New activity",
                size: "sm",
                variant: "secondary",
                onClick: Message.ClickedNew(),
              })
            : h.empty,
        ],
      ),
      model.error
        ? h.div(
            [
              h.Role("alert"),
              h.Class("flex shrink-0 items-center justify-between gap-3 py-2 text-body-sm"),
            ],
            [
              h.span([h.Class("text-destructive")], [model.error]),
              Button.view(h, {
                label: "Retry",
                variant: "secondary",
                size: "sm",
                onClick: Message.ClickedRetry(),
                isDisabled: model.loading,
              }),
            ],
          )
        : h.empty,
      !items.length
        ? !model.initialized && model.loading
          ? h.p(
              [h.Role("status"), h.Class("py-2 text-body-sm text-ink-muted")],
              ["Loading activity…"],
            )
          : emptyPanel(h, {
              attributes: [h.Role("status")],
              children: [
                filtered
                  ? "No matching activity; try another subject or clear the filters."
                  : "No activity yet; labeling decisions appear here once The Janitor evaluates an issue or pull request.",
              ],
            })
        : h.submodel({
            slotId: `activity-${model.mode}`,
            model: model[model.mode],
            view: VirtualList.view<Row>(),
            toParentMessage: (message) => Message.GotList({ mode: model.mode, message }),
            viewInputs: {
              items,
              itemToKey: (row) => (row.kind === "group" ? `group-${row.number}` : row.entry.id),
              itemToRowHeightPx: rowHeight,
              overscan: 4,
              containerClassName: "activity-list",
              itemToView: (row) =>
                row.kind === "event"
                  ? eventView(h, model, row.entry, row.expanded, repository, configuration)
                  : groupView(h, model, row),
            },
          }),
      h.footer(
        [
          h.Class(
            "flex min-h-10 shrink-0 items-center justify-between gap-3 text-body-sm text-ink-subtle",
          ),
        ],
        [
          h.span(
            [h.Role("status")],
            model.loading && model.initialized
              ? ["Updating…"]
              : [
                  h.span([h.Class("font-mono tabular-nums")], [String(model.entries.length)]),
                  " evaluations loaded",
                ],
          ),
          model.cursor && model.entries.length < MAX_LOADED
            ? Button.view(h, {
                label: "Load older activity",
                variant: "ghost",
                size: "sm",
                onClick: Message.ClickedMore(),
                isDisabled: model.loading,
              })
            : h.span(
                [],
                [
                  model.entries.length >= MAX_LOADED
                    ? "Refine your search to browse more history."
                    : model.entries.length
                      ? "End of activity"
                      : "",
                ],
              ),
        ],
      ),
    ],
  )
})
