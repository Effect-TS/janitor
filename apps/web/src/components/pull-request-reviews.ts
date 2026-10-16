import { RunId, type Trigger } from "@janitor/domain/PullRequestReview/Run"
import { RunEntry, RunPage } from "@janitor/domain/PullRequestReview/Settings"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage"
import * as Command from "foldkit/command"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as Submodel from "foldkit/submodel"
import * as Subscription from "foldkit/subscription"
import type * as Update from "foldkit/update"
import { ChevronDown, ChevronRight, GitPullRequest, RotateCw, Search } from "lucide"
import type { RepositoryOverview } from "./labeling-wire"
import * as Button from "./ui/button"
import { chip, type ChipVariant } from "./ui/chip"
import { inputGroup, inputGroupAddon, inputGroupInput } from "./ui/input-group"
import * as Page from "./ui/page"
import * as Table from "./ui/table"
import * as Icon from "@/lib/icons"
import { cn } from "@/lib/utils"

/**
 * The repository's "PR reviews" section (EFF-1930): a read-only runs list,
 * newest first, paged by cursor and refreshed like Activity. Running and
 * skipped runs are listed too. There is no detail view and no run control.
 * Like Activity, runs are grouped by pull request unless "All reviews" is
 * chosen, and the search matches a pull request's title or number.
 */

const Mode = Schema.Literals(["grouped", "all"])

export const Model = Schema.Struct({
  repositoryId: Schema.String,
  active: Schema.Boolean,
  mode: Mode,
  search: Schema.String,
  /** The search changed and its debounce hasn't settled yet. */
  searchPending: Schema.Boolean,
  /** Pull request numbers whose runs are shown in the grouped view. */
  expanded: Schema.Array(Schema.Int),
  runs: Schema.Array(RunEntry),
  /** Fetches the next, older page; null once the last page is loaded. */
  cursor: Schema.NullOr(RunId),
  loading: Schema.Boolean,
  loadingOlder: Schema.Boolean,
  initialized: Schema.Boolean,
  /** Refresh was clicked: the next first page replaces the list instead of merging. */
  replacing: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  /** Fences responses from an earlier repository or activation. */
  generation: Schema.Int,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  Activated: { repositoryId: Schema.String, active: Schema.Boolean },
  ChangedMode: { mode: Mode },
  ChangedSearch: { value: Schema.String },
  SettledSearch: { generation: Schema.Int },
  ToggledPullRequest: { number: Schema.Int },
  Polled: {},
  ClickedRefresh: {},
  ClickedMore: {},
  ClickedRetry: {},
  Loaded: { generation: Schema.Int, older: Schema.Boolean, page: RunPage },
  Failed: { generation: Schema.Int, reason: Schema.String },
})
export type Message = typeof Message.Type

export const init = (): Model => ({
  repositoryId: "",
  active: false,
  mode: "grouped",
  search: "",
  searchPending: false,
  expanded: [],
  runs: [],
  cursor: null,
  loading: false,
  loadingOlder: false,
  initialized: false,
  replacing: false,
  error: null,
  generation: 0,
})

const UNREACHABLE = "PR reviews could not be loaded. Check your connection and try again."

export const FetchRuns = Command.define("FetchPullRequestReviews", {
  args: {
    repositoryId: Schema.String,
    generation: Schema.Int,
    search: Schema.String,
    cursor: Schema.NullOr(RunId),
  },
  messages: [Message.Loaded, Message.Failed],
  execute: ({ repositoryId, generation, search, cursor }) =>
    Effect.gen(function* () {
      const params = new URLSearchParams()
      if (search !== "") params.set("search", search)
      if (cursor !== null) params.set("cursor", cursor)
      const query = params.size === 0 ? "" : `?${params}`
      const response = yield* HttpClient.get(
        `/api/v1/repositories/${encodeURIComponent(repositoryId)}/pull-request-review/runs${query}`,
      )
      if (response.status !== 200)
        return Message.Failed({
          generation,
          reason:
            response.status === 404
              ? "This repository is unavailable."
              : "PR reviews could not be loaded. Try again.",
        })
      const page = yield* HttpIncomingMessage.schemaBodyJson(RunPage)(response)
      return Message.Loaded({ generation, older: cursor !== null, page })
    }).pipe(
      Effect.timeout("15 seconds"),
      Effect.orElseSucceed(() => Message.Failed({ generation, reason: UNREACHABLE })),
    ),
})

type Return = Update.Return<Model, Message, HttpClient.HttpClient>

const fetchPage = (model: Model, older = false): Return => {
  if (!model.active || model.loading || (older && model.cursor === null)) return { model }
  return {
    model: { ...model, loading: true, loadingOlder: older, error: null },
    commands: [
      FetchRuns({
        repositoryId: model.repositoryId,
        generation: model.generation,
        search: model.search.trim(),
        cursor: older ? model.cursor : null,
      }),
    ],
  }
}

/** Drops the loaded runs and fences responses for the previous search. */
const reset = (model: Model): Model => ({
  ...model,
  runs: [],
  cursor: null,
  expanded: [],
  searchPending: false,
  loading: false,
  initialized: false,
  replacing: false,
  error: null,
  generation: model.generation + 1,
})

/**
 * A refreshed first page replaces the rows it covers, where running runs
 * change state. When it reaches a row already loaded, the older rows below
 * it stay, and so does the cursor past them. When it doesn't, runs may sit
 * between the two, so the list starts again from the page.
 */
const refreshed = (model: Model, page: RunPage): Model => {
  const fresh = new Set(page.runs.map((run) => run.runId))
  if (!model.runs.some((run) => fresh.has(run.runId)))
    return { ...model, runs: page.runs, cursor: page.cursor }
  return {
    ...model,
    runs: [...page.runs, ...model.runs.filter((run) => !fresh.has(run.runId))],
  }
}

export const update = (model: Model, message: Message): Return =>
  Message.match(message, {
    Activated: ({ repositoryId, active }) => {
      if (model.repositoryId === repositoryId && model.active === active) return { model }
      const next =
        repositoryId === model.repositoryId
          ? { ...model, active }
          : { ...init(), mode: model.mode, generation: model.generation, repositoryId, active }
      // Fence responses when leaving and refresh on return.
      const fenced = { ...next, loading: false, generation: next.generation + 1 }
      return active ? fetchPage(fenced) : { model: fenced }
    },
    ChangedMode: ({ mode }) => ({ model: { ...model, mode } }),
    ChangedSearch: ({ value }) => ({
      model: { ...reset({ ...model, search: value.slice(0, 200) }), searchPending: true },
    }),
    SettledSearch: ({ generation }) =>
      generation === model.generation ? fetchPage({ ...model, searchPending: false }) : { model },
    ToggledPullRequest: ({ number }) => ({
      model: {
        ...model,
        expanded: model.expanded.includes(number)
          ? model.expanded.filter((value) => value !== number)
          : [...model.expanded, number],
      },
    }),
    Polled: () => (model.searchPending ? { model } : fetchPage(model)),
    ClickedRefresh: () => {
      const step = fetchPage(model)
      return step.model === model ? step : { ...step, model: { ...step.model, replacing: true } }
    },
    ClickedMore: () => fetchPage(model, true),
    ClickedRetry: () => fetchPage(model, model.loadingOlder),
    Loaded: ({ generation, older, page }) => {
      if (generation !== model.generation || !model.active) return { model }
      const next = { ...model, loading: false, initialized: true, replacing: false, error: null }
      if (older) {
        const known = new Set(model.runs.map((run) => run.runId))
        return {
          model: {
            ...next,
            runs: [...model.runs, ...page.runs.filter((run) => !known.has(run.runId))],
            cursor: page.cursor,
          },
        }
      }
      return {
        model:
          model.initialized && !model.replacing
            ? refreshed(next, page)
            : { ...next, runs: page.runs, cursor: page.cursor },
      }
    },
    Failed: ({ generation, reason }) =>
      generation !== model.generation
        ? { model }
        : { model: { ...model, loading: false, error: reason } },
  })

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  reviewSearchDebounce: entry(
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

export type Group = {
  readonly number: number
  readonly runs: ReadonlyArray<RunEntry>
}

/** Runs grouped by pull request, the one reviewed most recently first. */
export const groups = (runs: ReadonlyArray<RunEntry>): ReadonlyArray<Group> => {
  const byNumber = new Map<number, Array<RunEntry>>()
  for (const run of runs) {
    const group = byNumber.get(run.number)
    if (group) group.push(run)
    else byNumber.set(run.number, [run])
  }
  return [...byNumber].map(([number, runs]) => ({ number, runs }))
}

// VIEW

const outcome = (run: RunEntry): { label: string; variant: ChipVariant } => {
  switch (run.status) {
    case "running":
      return { label: "Running", variant: "agent" }
    case "approved":
      return { label: "Approved", variant: "success" }
    case "changes_requested":
      return { label: "Changes requested", variant: "danger" }
    case "commented":
      return { label: "Commented", variant: "neutral" }
    case "partial":
      return { label: "Partial", variant: "neutral" }
    case "failed":
      return { label: "Failed", variant: "danger" }
    case "cancelled":
      return { label: "Cancelled", variant: "neutral" }
    case "skipped":
      return {
        label: `Skipped · ${run.reason === "oversized" ? "oversized" : "run cap"}`,
        variant: "neutral",
      }
  }
}

/** Gate tags such as `BlockingFindings` read as "blocking findings". */
const gateName = (gate: string) => gate.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`

/** Whole seconds, minutes or hours, at most two units: `45s`, `3m 20s`, `1h 5m`. */
export const describeDuration = (millis: number): string => {
  const seconds = Math.max(0, Math.round(millis / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

const timestamp = (at: DateTime.Utc) => DateTime.formatIso(at).slice(0, 16).replace("T", " ")

const repositoryUrl = (repository: RepositoryOverview) =>
  `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`

const external = (
  h: HtmlBuilder<Message>,
  href: string,
  children: ReadonlyArray<Html | string>,
  className = "text-primary hover:underline",
) =>
  h.a(
    [h.Href(href), h.Target("_blank"), h.Rel("noopener noreferrer"), h.Class(className)],
    children,
  )

const triggerLabel = (trigger: Trigger) =>
  trigger._tag === "Automatic"
    ? "Automatic"
    : `/janitor by @${trigger.invoker}${trigger._tag === "Forced" ? " · forced" : ""}`

const triggerView = (
  h: HtmlBuilder<Message>,
  run: RunEntry,
  repository: RepositoryOverview | undefined,
) =>
  run.trigger._tag === "Automatic" || repository === undefined
    ? h.span([h.Class("text-ink-muted")], [triggerLabel(run.trigger)])
    : external(
        h,
        `${repositoryUrl(repository)}/pull/${run.number}#issuecomment-${run.trigger.commentId}`,
        [triggerLabel(run.trigger)],
      )

const pullRequestView = (
  h: HtmlBuilder<Message>,
  run: RunEntry,
  repository: RepositoryOverview | undefined,
) => {
  const sha = run.headSha.slice(0, 7)
  const label = [h.span([h.Class("font-mono text-mono-sm")], [`#${run.number}`]), " ", run.title]
  return h.div(
    [h.Class("flex min-w-0 flex-col gap-0.5")],
    [
      repository === undefined
        ? h.span([h.Class("truncate")], label)
        : external(
            h,
            `${repositoryUrl(repository)}/pull/${run.number}`,
            label,
            "truncate hover:underline",
          ),
      repository === undefined
        ? h.span([h.Class("font-mono text-mono-xs text-ink-subtle"), h.Title(run.headSha)], [sha])
        : external(
            h,
            `${repositoryUrl(repository)}/commit/${run.headSha}`,
            [sha],
            "w-fit font-mono text-mono-xs text-ink-subtle hover:underline",
          ),
    ],
  )
}

const runRow = (
  h: HtmlBuilder<Message>,
  run: RunEntry,
  repository: RepositoryOverview | undefined,
  nested = false,
) => {
  const { label, variant } = outcome(run)
  const links = [
    ...(run.review === null ? [] : [external(h, run.review.url, ["GitHub review"])]),
    ...(run.checkRun === null ? [] : [external(h, run.checkRun.url, ["janitor/review"])]),
  ]
  return Table.row(h, {
    attributes: [h.DataAttribute("status", run.status)],
    children: [
      Table.cell(h, {
        className: cn("max-w-80 py-2", nested && "pl-11"),
        children: [pullRequestView(h, run, repository)],
      }),
      Table.cell(h, {
        className: "py-2",
        children: [
          h.div(
            [h.Class("flex flex-col items-start gap-1")],
            [
              chip(h, { variant, children: [label] }),
              run.failedGates.length === 0
                ? h.empty
                : h.span(
                    [h.Class("text-body-sm text-ink-muted")],
                    [`Failed gates: ${run.failedGates.map(gateName).join(", ")}`],
                  ),
            ],
          ),
        ],
      }),
      Table.cell(h, {
        className: "py-2 whitespace-nowrap",
        children: [
          run.status === "skipped"
            ? h.span([h.Class("text-ink-faint")], ["—"])
            : h.span([], [`${plural(run.blockers, "blocker")} · ${plural(run.nits, "nit")}`]),
        ],
      }),
      Table.cell(h, { className: "py-2", children: [triggerView(h, run, repository)] }),
      Table.cell(h, {
        code: true,
        className: "py-2 whitespace-nowrap",
        children: [
          h.span([h.Title(DateTime.formatIso(run.startedAt))], [timestamp(run.startedAt)]),
        ],
      }),
      Table.cell(h, {
        numeric: true,
        className: "py-2 whitespace-nowrap",
        children: [
          run.finishedAt === null
            ? h.span([h.Class("text-ink-faint")], ["—"])
            : h.span(
                [],
                [
                  describeDuration(
                    DateTime.toEpochMillis(run.finishedAt) - DateTime.toEpochMillis(run.startedAt),
                  ),
                ],
              ),
        ],
      }),
      Table.cell(h, {
        className: "py-2",
        children: [h.div([h.Class("flex flex-col items-start gap-0.5")], links)],
      }),
    ],
  })
}

const COLUMNS = 7

/** A pull request's heading row in the grouped view; clicking it shows its runs. */
const groupRow = (
  h: HtmlBuilder<Message>,
  group: Group,
  expanded: boolean,
  repository: RepositoryOverview | undefined,
) => {
  const latest = group.runs[0]!
  const { label, variant } = outcome(latest)
  const number = `#${group.number}`
  return Table.row(h, {
    className: cn(expanded && "bg-primary-wash hover:bg-primary-wash"),
    attributes: [h.DataAttribute("pull-request", String(group.number))],
    children: [
      Table.cell(h, {
        className: "relative py-0",
        attributes: [h.Colspan(COLUMNS)],
        children: [
          h.div(
            [h.Class("flex h-11 min-w-0 items-center gap-3")],
            [
              Icon.view(
                h,
                expanded ? ChevronDown : ChevronRight,
                "size-4 shrink-0 text-ink-subtle",
              ),
              Icon.view(h, GitPullRequest, "size-4 shrink-0 text-ink-subtle"),
              repository === undefined
                ? h.span([h.Class("shrink-0 font-mono text-mono-sm text-primary")], [number])
                : external(
                    h,
                    `${repositoryUrl(repository)}/pull/${group.number}`,
                    [number],
                    "relative z-10 shrink-0 font-mono text-mono-sm text-primary hover:underline",
                  ),
              h.span([h.Class("min-w-0 truncate font-medium")], [latest.title]),
              chip(h, { variant, children: [label] }),
              h.span(
                [h.Class("ml-auto shrink-0 font-mono text-mono-sm text-ink-subtle tabular-nums")],
                [plural(group.runs.length, "review")],
              ),
            ],
          ),
          h.button(
            [
              h.Type("button"),
              h.Class(
                "absolute inset-0 cursor-pointer rounded-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
              ),
              h.AriaLabel(`${number} ${latest.title}`),
              h.AriaExpanded(expanded),
              h.OnClick(Message.ToggledPullRequest({ number: group.number })),
            ],
            [],
          ),
        ],
      }),
    ],
  })
}

const rows = (
  h: HtmlBuilder<Message>,
  model: Model,
  repository: RepositoryOverview | undefined,
): ReadonlyArray<Html> =>
  model.mode === "all"
    ? model.runs.map((run) => runRow(h, run, repository))
    : groups(model.runs).flatMap((group) => {
        const expanded = model.expanded.includes(group.number)
        return [
          groupRow(h, group, expanded, repository),
          ...(expanded ? group.runs.map((run) => runRow(h, run, repository, true)) : []),
        ]
      })

const table = (h: HtmlBuilder<Message>, model: Model, repository: RepositoryOverview | undefined) =>
  h.div(
    [h.Class("overflow-x-auto")],
    [
      Table.table(h, {
        attributes: [h.AriaLabel("PR review runs")],
        children: [
          Table.head(h, [
            Table.row(h, {
              children: [
                Table.headCell(h, { children: ["Pull request"] }),
                Table.headCell(h, { children: ["Outcome"] }),
                Table.headCell(h, { children: ["Findings"] }),
                Table.headCell(h, { children: ["Trigger"] }),
                Table.headCell(h, { children: ["Started (UTC)"] }),
                Table.headCell(h, { numeric: true, children: ["Duration"] }),
                Table.headCell(h, { children: ["Links"] }),
              ],
            }),
          ]),
          Table.body(h, rows(h, model, repository)),
        ],
      }),
    ],
  )

export const view = Submodel.defineView<
  Model,
  Message,
  { repository: RepositoryOverview | undefined }
>((model, { repository }, h) => {
  const count = `${model.runs.length} ${model.runs.length === 1 ? "run" : "runs"}`
  const segment = (mode: typeof Mode.Type, label: string) =>
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
  const toolbar = h.div(
    [h.Class("flex shrink-0 flex-wrap items-center gap-3 lg:flex-nowrap")],
    [
      h.form(
        [
          h.Class("w-full max-w-80 min-w-40 shrink lg:w-80"),
          h.OnSubmit(Message.ChangedSearch({ value: model.search })),
        ],
        [
          inputGroup(h, {
            className: "h-8 rounded-md",
            children: [
              inputGroupAddon(h, { children: [Icon.view(h, Search, "size-4")] }),
              inputGroupInput(h, {
                id: "pull-request-review-search",
                type: "search",
                value: model.search,
                placeholder: "Find a pull request",
                ariaLabel: "Search PR reviews",
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
          h.AriaLabel("PR reviews view"),
        ],
        [segment("grouped", "By pull request"), segment("all", "All reviews")],
      ),
    ],
  )
  const card = h.section(
    [
      h.Class("flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card"),
      h.DataAttribute("slot", "card"),
    ],
    [
      model.runs.length === 0
        ? h.p(
            [h.Role("status"), h.Class("px-4 py-3 text-body-sm text-ink-muted")],
            [
              !model.initialized && (model.loading || model.searchPending)
                ? "Loading PR reviews…"
                : model.search.trim() !== ""
                  ? "No matching PR reviews; try another pull request or clear the search."
                  : "No PR reviews yet. Runs appear here once PR review is enabled in Settings and a pull request opens or changes.",
            ],
          )
        : table(h, model, repository),
      Page.footerStrip(
        h,
        [
          h.span(
            [h.Role("status")],
            model.loading && model.initialized ? ["Updating…"] : [`${count} loaded`],
          ),
        ],
        [
          model.cursor !== null
            ? Button.view(h, {
                label: "Load more",
                variant: "ghost",
                size: "sm",
                onClick: Message.ClickedMore(),
                isDisabled: model.loading,
              })
            : h.span([], [model.runs.length > 0 ? "End of PR reviews" : ""]),
        ],
      ),
    ],
  )
  return Page.layout(h, {
    attributes: [h.AriaLabel("Repository PR reviews")],
    main: [
      Page.header(h, {
        title: "PR reviews",
        lede: "Every pull request review The Janitor ran or skipped for this repository, newest first. Expand a pull request to see each review.",
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
      model.error === null
        ? h.empty
        : h.div(
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
          ),
      card,
    ],
  })
})
