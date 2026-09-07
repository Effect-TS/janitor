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
import type { HtmlBuilder } from "foldkit/html"
import {
  ActivityCursor,
  ActivityEntry,
  ActivityPage,
  type RepositoryOverview,
} from "./labeling-wire"
import * as Button from "./ui/button"
import * as Icon from "@/lib/icons"
import {
  Activity as ActivityIcon,
  Check,
  CircleAlert,
  Clock,
  ChevronRight,
  GitPullRequest,
  Search,
} from "lucide"
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
  collapsed: Schema.Array(Schema.Int),
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
  mode: "journal",
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
  collapsed: [],
  journal: VirtualList.init({ id: "activity-journal", rowHeightPx: 96 }),
  grouped: VirtualList.init({ id: "activity-grouped", rowHeightPx: 96 }),
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
  collapsed: [],
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
    ...(model.collapsed.includes(number) ? [] : entries.map(event)),
  ])
}
export const rowHeight = (row: Row) => (row.kind === "group" ? 72 : row.expanded ? 420 : 96)
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
            collapsed: [],
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
        collapsed: model.collapsed.includes(number)
          ? model.collapsed.filter((value) => value !== number)
          : [...model.collapsed, number],
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
const polling = Subscription.make<Model, Message>()((entry) => ({
  activityPoll: entry(
    { active: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ active: model.active }),
      dependenciesToStream: ({ active }) =>
        active ? Stream.map(Stream.tick("10 seconds"), () => Message.Polled()) : Stream.empty,
    },
  ),
}))
export const subscriptions = Subscription.aggregate<Model, Message>()(
  { journalEvents: listSubscriptions("journal").containerEvents },
  { groupedEvents: listSubscriptions("grouped").containerEvents },
  polling,
  searchChanges,
)
export const outcome = (
  entry: ActivityEntry,
): { label: string; tone: string; icon: typeof Check } => {
  if (entry.outcome === "failed" || entry.actions.some((action) => action.status === "failed"))
    return { label: "Labeling failed", tone: "text-destructive", icon: CircleAlert }
  if (!entry.outcome || entry.actions.some((action) => action.status === "planned"))
    return { label: "Pending", tone: "text-muted-foreground", icon: Clock }
  if (entry.outcome === "superseded")
    return { label: "Replaced by newer activity", tone: "text-muted-foreground", icon: Clock }
  if (entry.outcome === "not-qualified")
    return { label: "Waiting for a verified snapshot", tone: "text-muted-foreground", icon: Clock }
  if (entry.actions.some((action) => action.status === "applied"))
    return { label: "Labels updated", tone: "text-emerald-600 dark:text-emerald-400", icon: Check }
  if (entry.evaluations?.some((rule) => rule.reason.startsWith("Gate unresolved:")))
    return {
      label: "Gate unresolved · AI skipped",
      tone: "text-amber-700 dark:text-amber-400",
      icon: CircleAlert,
    }
  if (entry.plan?.rules.some((rule) => rule.outcome === "unknown"))
    return {
      label: "Could not decide · labels unchanged",
      tone: "text-amber-700 dark:text-amber-400",
      icon: CircleAlert,
    }
  return { label: "No label changes", tone: "text-muted-foreground", icon: Check }
}
const stamp = (entry: ActivityEntry) =>
  DateTime.formatUtc(entry.createdAt, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }) + " UTC"
const label = (h: HtmlBuilder<Message>, action: ActivityEntry["actions"][number]) =>
  h.span(
    [
      h.Class("activity-label"),
      ...(action.color && /^[0-9a-f]{6}$/i.test(action.color)
        ? [h.Style({ borderColor: `#${action.color}70`, backgroundColor: `#${action.color}18` })]
        : []),
    ],
    [action.name ?? `Label ${action.labelId}`],
  )
const eventView = (
  h: HtmlBuilder<Message>,
  model: Model,
  entry: ActivityEntry,
  expanded: boolean,
  repository: RepositoryOverview | undefined,
) => {
  const result = outcome(entry)
  return h.article(
    [h.Class("activity-event")],
    [
      h.button(
        [
          h.Class("activity-event-summary"),
          h.OnClick(Message.ToggledEvent({ id: entry.id })),
          h.AriaExpanded(expanded),
        ],
        [
          h.span(
            [h.Class(`activity-event-icon ${result.tone}`)],
            [Icon.view(h, result.icon, "size-4")],
          ),
          h.div(
            [h.Class("min-w-0 flex-1")],
            [
              h.div(
                [h.Class("truncate text-sm font-medium")],
                [entry.title ?? `Subject #${entry.number}`],
              ),
              h.div(
                [h.Class("activity-event-meta")],
                [
                  h.span([], [`#${entry.number}`]),
                  h.span([h.Class(result.tone)], [result.label]),
                  ...entry.actions
                    .slice(0, 2)
                    .map((action) =>
                      h.span(
                        [h.Class("inline-flex items-center gap-1")],
                        [
                          action.status === "applied"
                            ? action.action === "add"
                              ? "Added"
                              : "Removed"
                            : action.status === "failed"
                              ? "Failed"
                              : "Pending",
                          label(h, action),
                        ],
                      ),
                    ),
                ],
              ),
              h.time([h.Class("text-[10px] text-muted-foreground")], [stamp(entry)]),
            ],
          ),
          Icon.view(
            h,
            ChevronRight,
            `size-4 shrink-0 text-muted-foreground ${expanded ? "rotate-90" : ""}`,
          ),
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
                [h.Class("flex items-center justify-between mb-3")],
                [
                  h.h3([h.Class("text-xs font-medium")], ["Evaluation details"]),
                  repository && entry.kind
                    ? h.a(
                        [
                          h.Href(
                            `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/${entry.kind === "issue" ? "issues" : "pull"}/${entry.number}`,
                          ),
                          h.Target("_blank"),
                          h.Rel("noopener noreferrer"),
                          h.Class("text-xs underline"),
                        ],
                        ["Open on GitHub"],
                      )
                    : h.empty,
                ],
              ),
              entry.detail
                ? h.p(
                    [h.Class("mb-3 text-xs text-muted-foreground whitespace-pre-wrap")],
                    [entry.detail],
                  )
                : h.empty,
              ...(entry.evaluations ?? []).map((evaluation) =>
                h.div(
                  [h.Class("activity-detail-row")],
                  [
                    h.div(
                      [],
                      [
                        h.p(
                          [h.Class("text-xs font-medium")],
                          [
                            evaluation.reason.startsWith("Skipped by gate:")
                              ? "Skipped by gate"
                              : evaluation.outcome,
                          ],
                        ),
                        h.p([h.Class("text-xs text-muted-foreground mt-1")], [evaluation.reason]),
                      ],
                    ),
                    h.a(
                      [
                        h.Href(
                          Routes.rule({
                            repositoryId: model.repositoryId,
                            ruleId: evaluation.ruleId,
                          }),
                        ),
                        h.Class("text-xs underline"),
                      ],
                      ["View rule"],
                    ),
                  ],
                ),
              ),
              ...entry.actions.map((action) =>
                h.div(
                  [h.Class("activity-detail-row")],
                  [
                    h.div(
                      [],
                      [
                        label(h, action),
                        h.p(
                          [h.Class("text-xs mt-1")],
                          [
                            `${action.action === "add" ? "Add" : "Remove"} label · ${action.status}`,
                          ],
                        ),
                        action.detail
                          ? h.p([h.Class("text-xs text-muted-foreground mt-1")], [action.detail])
                          : h.empty,
                      ],
                    ),
                    h.a(
                      [
                        h.Href(
                          Routes.rule({ repositoryId: model.repositoryId, ruleId: action.ruleId }),
                        ),
                        h.Class("text-xs underline"),
                      ],
                      ["View rule"],
                    ),
                  ],
                ),
              ),
              ...(entry.plan?.rules.map((rule) =>
                h.div(
                  [h.Class("activity-detail-row text-xs")],
                  [
                    h.a(
                      [
                        h.Href(
                          Routes.rule({ repositoryId: model.repositoryId, ruleId: rule.ruleId }),
                        ),
                        h.Class("underline"),
                      ],
                      ["Rule " + rule.ruleId.slice(0, 8)],
                    ),
                    h.span(
                      [h.Class("text-muted-foreground")],
                      [rule.outcome + (rule.selected ? " · selected" : "")],
                    ),
                  ],
                ),
              ) ?? []),
              !entry.actions.length
                ? h.p(
                    [h.Class("text-xs text-muted-foreground mb-3")],
                    [
                      entry.plan?.rules.some((rule) => rule.outcome === "unknown")
                        ? "Unresolved rules preserved existing labels."
                        : "No label writes were recorded for this evaluation.",
                    ],
                  )
                : h.empty,
              h.p(
                [h.Class("text-[10px] text-muted-foreground mt-3")],
                [
                  `Rules revision ${entry.revision} · ${stamp(entry)}. Titles and label names reflect current repository data.`,
                ],
              ),
            ],
          )
        : h.empty,
    ],
  )
}
export const view = Submodel.defineView<
  Model,
  Message,
  { repository: RepositoryOverview | undefined }
>((model, { repository }, h) => {
  const items = rows(model)
  return h.section(
    [h.Class("activity-workspace"), h.AriaLabel("Repository activity")],
    [
      h.div(
        [h.Class("activity-toolbar")],
        [
          h.form(
            [
              h.Class("activity-search"),
              h.OnSubmit(Message.ChangedSearch({ value: model.search })),
            ],
            [
              Icon.view(h, Search, "size-4 text-muted-foreground"),
              h.input([
                h.Type("search"),
                h.Value(model.search),
                h.Placeholder("Find an issue or pull request…"),
                h.AriaLabel("Search activity"),
                h.OnInput((value) => Message.ChangedSearch({ value })),
              ]),
            ],
          ),
          h.div(
            [h.Class("activity-view-toggle"), h.Role("group"), h.AriaLabel("Activity view")],
            (["journal", "grouped"] as const).map((mode) =>
              h.button(
                [
                  h.Type("button"),
                  h.AriaPressed(String(model.mode === mode)),
                  h.OnClick(Message.ChangedMode({ mode })),
                ],
                [mode === "journal" ? "Journal" : "By subject"],
              ),
            ),
          ),
          h.select(
            [
              h.Class("activity-target"),
              h.Value(model.target),
              h.AriaLabel("Subject type"),
              h.OnChange((value) =>
                Message.ChangedTarget({
                  target:
                    value === "issue" ? "issue" : value === "pull_request" ? "pull_request" : "all",
                }),
              ),
            ],
            [
              h.option([h.Value("all")], ["All subjects"]),
              h.option([h.Value("pull_request")], ["Pull requests"]),
              h.option([h.Value("issue")], ["Issues"]),
            ],
          ),
          model.pending
            ? Button.view(h, {
                label: "New activity",
                size: "sm",
                variant: "outline",
                onClick: Message.ClickedNew(),
              })
            : h.empty,
        ],
      ),
      model.error
        ? h.div(
            [h.Role("alert"), h.Class("activity-notice")],
            [
              model.error,
              Button.view(h, {
                label: "Retry",
                variant: "outline",
                size: "sm",
                onClick: Message.ClickedRetry(),
                isDisabled: model.loading,
              }),
            ],
          )
        : h.empty,
      !items.length
        ? h.div(
            [h.Class("activity-empty"), h.Role("status")],
            [
              Icon.view(h, ActivityIcon, "size-8 text-muted-foreground"),
              h.h2(
                [h.Class("text-sm font-medium")],
                [
                  !model.initialized && model.loading
                    ? "Loading activity…"
                    : model.search || model.target !== "all"
                      ? "No matching activity"
                      : "No activity yet",
                ],
              ),
              h.p(
                [h.Class("text-xs text-muted-foreground")],
                [
                  model.search || model.target !== "all"
                    ? "Try another subject or clear your filters."
                    : "Labeling decisions will appear here as Janitor evaluates issues and pull requests.",
                ],
              ),
            ],
          )
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
                  ? eventView(h, model, row.entry, row.expanded, repository)
                  : h.button(
                      [
                        h.Class("activity-group"),
                        h.OnClick(Message.ToggledGroup({ number: row.number })),
                        h.AriaExpanded(!model.collapsed.includes(row.number)),
                      ],
                      [
                        Icon.view(h, GitPullRequest, "size-4 shrink-0"),
                        h.span(
                          [h.Class("min-w-0 flex-1 text-left")],
                          [
                            h.span([h.Class("block truncate text-sm font-medium")], [row.title]),
                            h.span(
                              [h.Class("text-xs text-muted-foreground")],
                              [`#${row.number} · ${row.count} loaded evaluations`],
                            ),
                          ],
                        ),
                        Icon.view(
                          h,
                          ChevronRight,
                          `size-4 ${model.collapsed.includes(row.number) ? "" : "rotate-90"}`,
                        ),
                      ],
                    ),
            },
          }),
      h.footer(
        [h.Class("activity-footer")],
        [
          h.span(
            [h.Role("status")],
            [
              model.loading && model.initialized
                ? "Updating…"
                : `${model.entries.length} evaluations loaded`,
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
