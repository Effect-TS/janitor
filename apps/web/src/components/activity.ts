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
import * as Page from "./ui/page"
import * as Select from "./ui/select"
import * as Table from "./ui/table"
import * as Icon from "@/lib/icons"
import { cn } from "@/lib/utils"
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleDot,
  CircleHelp,
  Clock,
  GitPullRequest,
  RotateCw,
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
  ClickedRefresh: {},
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
  journal: VirtualList.init({ id: "activity-journal", rowHeightPx: 44 }),
  grouped: VirtualList.init({ id: "activity-grouped", rowHeightPx: 44 }),
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
/** Every rule the run touched: planned, evaluated, or acted on. */
export const ruleIds = (entry: ActivityEntry): ReadonlyArray<string> => [
  ...new Set([
    ...(entry.plan?.rules.map((rule) => rule.ruleId) ?? []),
    ...(entry.evaluations?.map((rule) => rule.ruleId) ?? []),
    ...entry.actions.map((action) => action.ruleId),
  ]),
]
/** Fixed row heights for the virtual list. A run row is a 24px line inside
 *  12px padding plus its hairline; an open run adds the evaluation table:
 *  8px gap, 32px head, 36px per rule (or one 20px note when no rule ran). */
export const SUBJECT_ROW = 44
export const RUN_ROW = 49
export const TABLE_HEAD = 40
export const TABLE_RULE = 36
export const rowHeight = (row: Row) =>
  row.kind === "group"
    ? SUBJECT_ROW
    : !row.expanded
      ? RUN_ROW
      : ruleIds(row.entry).length === 0
        ? RUN_ROW + 28
        : RUN_ROW + TABLE_HEAD + TABLE_RULE * ruleIds(row.entry).length
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
    ClickedRefresh: () => fetchPage({ ...model, error: null }),
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
    ToggledGroup: ({ number }) => {
      if (model.expandedGroups.includes(number))
        return {
          model: {
            ...model,
            expandedGroups: model.expandedGroups.filter((value) => value !== number),
          },
        }
      // Opening a subject also opens its newest run so the table is one click away.
      const newest = model.entries.find((entry) => entry.number === number)
      const opened = newest && ruleIds(newest).length > 0 ? [newest.id] : []
      return {
        model: {
          ...model,
          expandedGroups: [...model.expandedGroups, number],
          expanded: [...model.expanded.filter((id) => !opened.includes(id)), ...opened],
        },
      }
    },
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
const failed = (entry: ActivityEntry) => outcome(entry).tone === "text-destructive"
/** "1 change applied · 1 change failed", or "no label changes". */
const changes = (entry: ActivityEntry): string => {
  const count = (status: ActivityEntry["actions"][number]["status"], word: string) => {
    const n = entry.actions.filter((action) => action.status === status).length
    return n === 0 ? [] : [`${n} ${n === 1 ? "change" : "changes"} ${word}`]
  }
  const parts = [
    ...count("applied", "applied"),
    ...count("failed", "failed"),
    ...count("planned", "pending"),
  ]
  return parts.length === 0 ? "no label changes" : parts.join(" · ")
}
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
const stamp = (entry: ActivityEntry) =>
  DateTime.formatUtc(entry.createdAt, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }) + " UTC"
const clock = (at: DateTime.Utc) =>
  DateTime.formatUtc(at, { hour: "2-digit", minute: "2-digit", hour12: false })
const started = (at: DateTime.Utc) =>
  DateTime.formatIso(at)
    .replace("T", " ")
    .replace(/\.\d+Z$/, "Z")
const isHex = (color: string | null | undefined): color is string =>
  color !== null && color !== undefined && /^[0-9a-f]{6}$/i.test(color)
/** GitHub label colour as a 6px dot inside a neutral chip; never a fill. */
const labelDot = (h: HtmlBuilder<Message>, color: string | null | undefined) =>
  h.span(
    [
      h.Class(cn("size-1.5 shrink-0 rounded-full", isHex(color) ? "" : "bg-ink-faint")),
      ...(isHex(color) ? [h.Style({ backgroundColor: `#${color}` })] : []),
      h.AriaHidden(true),
    ],
    [],
  )
const labelChip = (
  h: HtmlBuilder<Message>,
  name: string,
  color: string | null | undefined,
  gone = false,
) =>
  chip(h, {
    className: cn(gone && "line-through text-ink-subtle"),
    children: [labelDot(h, color), name],
  })
type Outcome = "match" | "no match" | "failed" | "pending" | "undecided" | "skipped" | "—"
const outcomeChip = (h: HtmlBuilder<Message>, text: string) => {
  const strong = text === "match" || text === "applied" || text === "failed"
  return chip(h, {
    variant: text === "failed" ? "danger" : strong ? "success" : "neutral",
    className: cn(!strong && "text-ink-muted"),
    children: [text],
  })
}
const githubUrl = (repository: RepositoryOverview | undefined, entry: ActivityEntry) =>
  repository
    ? `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/${entry.kind === "pull_request" ? "pull" : "issues"}/${entry.number}`
    : null
/** Mono `#42` in primary; a GitHub link when the repository is known. Sits
 *  above the row's overlay button (see `overlay`). */
const subjectLink = (
  h: HtmlBuilder<Message>,
  repository: RepositoryOverview | undefined,
  entry: ActivityEntry,
) => {
  const href = githubUrl(repository, entry)
  return href === null
    ? h.span([h.Class("shrink-0 font-mono text-mono-sm text-primary")], [`#${entry.number}`])
    : h.a(
        [
          h.Href(href),
          h.Target("_blank"),
          h.Rel("noopener noreferrer"),
          h.Class("relative z-10 shrink-0 font-mono text-mono-sm text-primary hover:underline"),
        ],
        [`#${entry.number}`],
      )
}
/** The row's click target: a button covering the row so links inside stay
 *  real links. Place it last in the row and mark links `relative z-10`. */
const overlay = (h: HtmlBuilder<Message>, label: string, expanded: boolean, message: Message) =>
  h.button(
    [
      h.Type("button"),
      h.Class(
        "absolute inset-0 cursor-pointer rounded-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
      ),
      h.AriaLabel(label),
      h.AriaExpanded(expanded),
      h.OnClick(message),
    ],
    [],
  )
const kindIcon = (h: HtmlBuilder<Message>, kind: ActivityEntry["kind"]) =>
  Icon.view(
    h,
    kind === "pull_request" ? GitPullRequest : CircleDot,
    "size-4 shrink-0 text-ink-subtle",
  )
type RuleLine = {
  readonly id: string
  readonly name: string
  readonly color: string | null | undefined
  readonly gone: boolean
  readonly linked: boolean
  readonly result: Outcome
  readonly reason: string
  readonly actions: ReadonlyArray<ActivityEntry["actions"][number]>
}
const ruleLines = (
  entry: ActivityEntry,
  configuration: ConfigurationView | undefined,
): ReadonlyArray<RuleLine> =>
  ruleIds(entry).map((id) => {
    const decision = entry.plan?.rules.find((rule) => rule.ruleId === id)
    const evaluation = entry.evaluations?.find((rule) => rule.ruleId === id)
    const actions = entry.actions.filter((action) => action.ruleId === id)
    const rule = configuration?.rules.find((rule) => rule.id === id)
    const labelId = rule?.labelId ?? actions[0]?.labelId
    const currentLabel = configuration?.labels.find((label) => label.labelId === labelId)
    const skipped = evaluation?.reason.startsWith("Skipped by gate:") === true
    const raw = decision?.outcome ?? evaluation?.outcome
    const result: Outcome = skipped
      ? "skipped"
      : raw === "match"
        ? "match"
        : raw === "no-match"
          ? "no match"
          : raw === "failed"
            ? "failed"
            : raw === "unknown"
              ? "undecided"
              : raw === undefined
                ? "—"
                : "pending"
    return {
      id,
      name:
        currentLabel?.name ??
        actions.find((action) => action.name)?.name ??
        `Rule ${id.slice(0, 8)}`,
      color: currentLabel?.color ?? actions.find((action) => action.color)?.color,
      gone:
        configuration !== undefined &&
        labelId !== undefined &&
        (currentLabel === undefined || currentLabel.availability === "unavailable"),
      linked: rule !== undefined,
      result,
      reason:
        evaluation?.reason ??
        (decision?.requestedAction
          ? describeResultAction(decision.requestedAction)
          : rule && !rule.enabled
            ? "rule disabled"
            : "—"),
      actions,
    }
  })
const actionCells = (
  h: HtmlBuilder<Message>,
  actions: ReadonlyArray<ActivityEntry["actions"][number]>,
): ReadonlyArray<Html> =>
  actions.flatMap((action) => [
    h.span([h.Class("font-mono text-mono-sm")], [action.action]),
    outcomeChip(h, action.status === "planned" ? "pending" : action.status),
  ])
const ruleCell = (h: HtmlBuilder<Message>, model: Model, line: RuleLine) => {
  const badge = labelChip(h, line.name, line.color, line.gone)
  return line.linked
    ? h.a(
        [
          h.Href(Routes.rule({ repositoryId: model.repositoryId, ruleId: line.id })),
          h.Class("inline-flex max-w-full hover:underline"),
        ],
        [badge],
      )
    : badge
}
const head = (h: HtmlBuilder<Message>, text: string, className?: string) =>
  Table.headCell(h, { className: cn("h-8 bg-transparent", className), children: [text] })
const cell = (
  h: HtmlBuilder<Message>,
  children: ReadonlyArray<Html | string>,
  className?: string,
) => Table.cell(h, { className: cn("h-9 py-0", className), children })
/** Rule / Outcome / Reason / Action, one row per rule the run touched. */
const evaluationTable = (
  h: HtmlBuilder<Message>,
  model: Model,
  entry: ActivityEntry,
  configuration: ConfigurationView | undefined,
) => {
  const lines = ruleLines(entry, configuration)
  if (lines.length === 0)
    return h.p(
      [h.Class("text-body-sm text-ink-muted leading-5")],
      [entry.detail ? sentence(entry.detail) : "No rule ran for this revision."],
    )
  return Table.table(h, {
    className: "max-w-[720px]",
    children: [
      Table.head(h, [
        h.tr(
          [],
          [
            head(h, "Rule", "min-w-32"),
            head(h, "Outcome", "min-w-28"),
            head(h, "Reason", "w-full max-w-0"),
            head(h, "Action", "min-w-36"),
          ],
        ),
      ]),
      Table.body(
        h,
        lines.map((line) =>
          h.tr(
            [
              h.Class("border-b border-border-subtle last:border-b-0"),
              h.DataAttribute("rule", line.id),
            ],
            [
              cell(h, [ruleCell(h, model, line)]),
              cell(h, [
                line.result === "—"
                  ? h.span([h.Class("text-ink-subtle")], ["—"])
                  : outcomeChip(h, line.result),
              ]),
              cell(
                h,
                [
                  h.span(
                    [
                      h.Class("block truncate font-mono text-mono-sm text-ink-muted"),
                      h.Title(line.reason),
                    ],
                    [line.reason],
                  ),
                ],
                "w-full max-w-0",
              ),
              cell(h, [
                line.actions.length === 0
                  ? h.span([h.Class("text-ink-subtle")], ["—"])
                  : h.span([h.Class("flex items-center gap-2")], actionCells(h, line.actions)),
              ]),
            ],
          ),
        ),
      ),
    ],
  })
}
/** "The Janitor evaluated revision 7 · 1 change applied", or the one-line
 *  form for runs that never evaluated. */
const runLine = (
  h: HtmlBuilder<Message>,
  entry: ActivityEntry,
  repository: RepositoryOverview | undefined,
  journal: boolean,
): ReadonlyArray<Html | string> => {
  const actor = h.span(
    [h.Class("font-semibold text-agent-ink"), h.DataAttribute("actor", "agent")],
    [Feed.AGENT_NAME],
  )
  const subject = journal ? [subjectLink(h, repository, entry)] : []
  const word = (text: string) => h.span([], [text])
  const detail = (text: string) =>
    h.span([h.Class("min-w-0 truncate text-ink-muted"), h.Title(text)], [text])
  if (entry.outcome === "evaluated" || entry.outcome === null)
    return [
      actor,
      word(entry.outcome === null ? "is evaluating" : "evaluated"),
      ...subject,
      word("revision"),
      h.span([h.Class("font-mono text-mono-sm")], [String(entry.revision)]),
      detail(`· ${changes(entry)}`),
    ]
  return [
    actor,
    word(entry.outcome === "failed" ? "could not evaluate" : "skipped a run"),
    ...subject,
    outcomeChip(h, entry.outcome === "not-qualified" ? "not qualified" : entry.outcome),
    ...(entry.detail ? [detail(sentence(entry.detail))] : []),
  ]
}
const runView = (
  h: HtmlBuilder<Message>,
  model: Model,
  entry: ActivityEntry,
  expanded: boolean,
  repository: RepositoryOverview | undefined,
  configuration: ConfigurationView | undefined,
) => {
  const journal = model.mode === "journal"
  const expandable = ruleIds(entry).length > 0 || entry.detail !== null
  return h.article(
    [
      h.Class(
        cn(
          "flex h-full items-start gap-3 overflow-hidden border-b border-border-subtle bg-card py-3 pr-4",
          journal ? "pl-4" : "pl-12",
        ),
      ),
      h.DataAttribute("slot", "feed-item"),
      h.DataAttribute("actor", "agent"),
    ],
    [
      h.span([h.Class("oc-agent-dot mt-2"), h.AriaHidden(true)], []),
      h.div(
        [h.Class("flex min-w-0 flex-1 flex-col gap-2")],
        [
          h.div(
            [h.Class("relative flex items-start gap-3")],
            [
              h.div(
                [
                  h.Class(
                    "flex min-h-6 min-w-0 flex-1 items-center gap-x-1.5 text-body-md leading-5 whitespace-nowrap",
                  ),
                ],
                runLine(h, entry, repository, journal),
              ),
              h.time(
                [h.Class("shrink-0 font-mono text-mono-xs leading-6 text-ink-subtle tabular-nums")],
                [stamp(entry)],
              ),
              ...(expandable
                ? [
                    overlay(
                      h,
                      `Evaluation of #${entry.number} revision ${entry.revision}`,
                      expanded,
                      Message.ToggledEvent({ id: entry.id }),
                    ),
                  ]
                : []),
            ],
          ),
          expanded ? evaluationTable(h, model, entry, configuration) : h.empty,
        ],
      ),
    ],
  )
}
const subjectView = (
  h: HtmlBuilder<Message>,
  model: Model,
  row: Row & { kind: "group" },
  repository: RepositoryOverview | undefined,
) => {
  const expanded = model.expandedGroups.includes(row.number)
  const latest = model.entries.find((entry) => entry.number === row.number)
  return h.div(
    [
      h.Class(
        cn(
          "relative flex h-full items-center gap-3 border-b border-border-subtle px-4 transition-colors duration-120 ease-ui",
          expanded ? "bg-primary-wash" : "hover:bg-surface-muted",
        ),
      ),
      h.DataAttribute("slot", "subject-row"),
    ],
    [
      Icon.view(h, expanded ? ChevronDown : ChevronRight, "size-4 shrink-0 text-ink-subtle"),
      kindIcon(h, latest?.kind ?? null),
      latest
        ? subjectLink(h, repository, latest)
        : h.span([h.Class("font-mono text-mono-sm text-primary")], [`#${row.number}`]),
      h.span([h.Class("min-w-0 truncate text-body-md font-medium")], [row.title]),
      ...(latest && failed(latest) ? [outcomeChip(h, "failed")] : []),
      h.span(
        [h.Class("ml-auto shrink-0 font-mono text-mono-sm text-ink-subtle tabular-nums")],
        [`${row.count} ${row.count === 1 ? "evaluation" : "evaluations"}`],
      ),
      overlay(
        h,
        `#${row.number} ${row.title}`,
        expanded,
        Message.ToggledGroup({ number: row.number }),
      ),
    ],
  )
}
/** The run the inspector describes: the most recently opened one still on screen. */
export const openRun = (model: Model): ActivityEntry | undefined => {
  const visible = new Set(
    rows(model).flatMap((row) => (row.kind === "event" && row.expanded ? [row.entry.id] : [])),
  )
  const id = [...model.expanded].reverse().find((id) => visible.has(id))
  return id === undefined ? undefined : model.entries.find((entry) => entry.id === id)
}
const inspector = (
  h: HtmlBuilder<Message>,
  model: Model,
  repository: RepositoryOverview | undefined,
  configuration: ConfigurationView | undefined,
): ReadonlyArray<Html> => {
  const run = openRun(model)
  if (run === undefined)
    return [
      Page.inspectorCard(h, {
        heading: "Run",
        children: [
          h.p([h.Class("text-body-sm text-ink-muted")], ["Expand a run to see what it did."]),
        ],
      }),
    ]
  const lines = ruleLines(run, configuration)
  return [
    Page.inspectorCard(h, {
      heading: "Run",
      children: [
        Page.kvList(h, [
          Page.kv(h, "Subject", [
            subjectLink(h, repository, run),
            ` · ${run.kind === "pull_request" ? "PR" : "Issue"}`,
          ]),
          Page.kv(h, "Revision", String(run.revision)),
          Page.kv(h, "Started", started(run.createdAt)),
          Page.kv(h, "Outcome", run.outcome ?? "pending"),
        ]),
      ],
    }),
    Page.inspectorCard(h, {
      heading: "Actions",
      children:
        run.actions.length === 0
          ? [h.p([h.Class("text-body-sm text-ink-muted")], ["No label changes."])]
          : run.actions.map((action) => {
              const line = lines.find((line) => line.id === action.ruleId)
              const ruleRef = h.span(
                [h.Class("ml-auto shrink-0 font-mono text-mono-xs text-ink-subtle")],
                [action.ruleId.slice(0, 8)],
              )
              return h.div(
                [h.Class("flex items-center gap-2 py-1.5 text-body-md")],
                [
                  labelChip(
                    h,
                    action.name ?? line?.name ?? `Label ${action.labelId}`,
                    action.color ?? line?.color,
                    line?.gone ?? false,
                  ),
                  ...actionCells(h, [action]),
                  line?.linked
                    ? h.a(
                        [
                          h.Href(
                            Routes.rule({
                              repositoryId: model.repositoryId,
                              ruleId: action.ruleId,
                            }),
                          ),
                          h.Class("ml-auto shrink-0 hover:underline"),
                        ],
                        [
                          h.span(
                            [h.Class("font-mono text-mono-xs text-ink-subtle")],
                            [action.ruleId.slice(0, 8)],
                          ),
                        ],
                      )
                    : ruleRef,
                ],
              )
            }),
    }),
  ]
}
const segment = (h: HtmlBuilder<Message>, model: Model, mode: typeof Mode.Type, label: string) =>
  h.button(
    [
      h.Type("button"),
      h.Class(
        cn(
          "inline-flex h-[30px] cursor-pointer items-center whitespace-nowrap px-3 text-body-md transition-colors duration-120 ease-ui",
          model.mode === mode
            ? "bg-primary-wash font-medium"
            : "text-ink-muted hover:bg-surface-muted",
        ),
      ),
      h.AriaPressed(String(model.mode === mode)),
      h.OnClick(Message.ChangedMode({ mode })),
    ],
    [label],
  )
export const view = Submodel.defineView<
  Model,
  Message,
  { repository: RepositoryOverview | undefined; configuration?: ConfigurationView | undefined }
>((model, { repository, configuration }, h) => {
  const items = rows(model)
  const filtered = model.search || model.target !== "all"
  const newest = model.entries[0]
  const toolbar = h.div(
    [h.Class("flex shrink-0 flex-wrap items-center gap-3")],
    [
      h.form(
        [
          h.Class("w-full max-w-80 min-w-40 shrink"),
          h.OnSubmit(Message.ChangedSearch({ value: model.search })),
        ],
        [
          inputGroup(h, {
            className: "h-8 rounded-md",
            children: [
              inputGroupAddon(h, { children: [Icon.view(h, Search, "size-4")] }),
              inputGroupInput(h, {
                id: "activity-search",
                type: "search",
                value: model.search,
                placeholder: "Find an issue or pull request",
                ariaLabel: "Search activity",
                onInput: (value) => Message.ChangedSearch({ value }),
              }),
            ],
          }),
        ],
      ),
      h.div(
        [
          h.Class("flex shrink-0 overflow-hidden rounded-md border border-border"),
          h.Role("group"),
          h.AriaLabel("Activity view"),
        ],
        [segment(h, model, "journal", "Journal"), segment(h, model, "grouped", "By subject")],
      ),
      Select.view(h, {
        id: "activity-target",
        label: "Subject type",
        isLabelHidden: true,
        wrapperClass: "w-44 shrink-0",
        value: model.target,
        options: [
          ["all", "All subjects"],
          ["pull_request", "Pull requests"],
          ["issue", "Issues"],
        ],
        onChange: (value) =>
          Message.ChangedTarget({
            target: value === "issue" ? "issue" : value === "pull_request" ? "pull_request" : "all",
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
      h.span(
        [
          h.Class(
            "ml-auto shrink-0 whitespace-nowrap font-mono text-mono-sm text-ink-subtle tabular-nums",
          ),
        ],
        [
          `${model.entries.length} ${model.entries.length === 1 ? "evaluation" : "evaluations"}`,
          ...(newest ? [` · updated ${clock(newest.createdAt)}`] : []),
        ],
      ),
    ],
  )
  const list = !items.length
    ? h.p(
        [h.Role("status"), h.Class("px-4 py-3 text-body-sm text-ink-muted")],
        [
          !model.initialized && model.loading
            ? "Loading activity…"
            : filtered
              ? "No matching activity; try another subject or clear the filters."
              : "No activity yet; labeling decisions appear here once The Janitor evaluates an issue or pull request.",
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
          containerClassName: "min-h-0 overflow-auto [overflow-anchor:none]",
          itemToView: (row) =>
            row.kind === "event"
              ? runView(h, model, row.entry, row.expanded, repository, configuration)
              : subjectView(h, model, row, repository),
        },
      })
  const card = h.section(
    [
      h.Class(
        "flex min-h-0 shrink flex-col overflow-hidden rounded-lg border border-border bg-card",
      ),
      h.DataAttribute("slot", "card"),
    ],
    [
      list,
      Page.footerStrip(
        h,
        [
          h.span(
            [h.Role("status")],
            model.loading && model.initialized
              ? ["Updating…"]
              : [
                  h.span([h.Class("font-mono tabular-nums")], [String(model.entries.length)]),
                  ` ${model.entries.length === 1 ? "evaluation" : "evaluations"} loaded`,
                ],
          ),
        ],
        [
          model.cursor && model.entries.length < MAX_LOADED
            ? Button.view(h, {
                label: "Load more",
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
  return Page.layout(h, {
    className: "h-full min-h-0 [&>main]:min-h-0 [&>aside]:overflow-y-auto",
    attributes: [h.AriaLabel("Repository activity")],
    main: [
      Page.header(h, {
        title: "Activity",
        lede: "Every evaluation The Janitor ran for this repository, newest first. Expand a subject to see what each rule decided.",
        actions: [
          Button.view(h, {
            variant: "secondary",
            label: h.span([h.Class("contents")], [Icon.view(h, RotateCw, "size-4"), "Refresh"]),
            onClick: Message.ClickedRefresh(),
            isDisabled: model.loading,
          }),
        ],
      }),
      toolbar,
      model.error
        ? h.div(
            [
              h.Role("alert"),
              h.Class("flex shrink-0 items-center justify-between gap-3 text-body-sm"),
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
      card,
    ],
    inspector: inspector(h, model, repository, configuration),
  })
})
