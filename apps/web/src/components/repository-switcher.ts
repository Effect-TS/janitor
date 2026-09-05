import * as Routes from "@/routes"
import * as Popover from "@foldkit/ui/popover"
import * as Array from "effect/Array"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as FoldkitCommand from "foldkit/command"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { evo } from "foldkit/struct"
import * as Submodel from "foldkit/submodel"
import * as Update from "foldkit/update"
import { Check, ChevronsUpDown } from "lucide"
import type { RepositoryOverview } from "@/components/labeling-wire"
import * as CommandPalette from "@/components/ui/command"
import * as Button from "@/components/ui/button"
import * as Icon from "@/lib/icons"
import { cn } from "@/lib/utils"

/**
 * The repository switcher under the sidebar's brand header. The trigger shows
 * the selected repository; pressing it opens a command palette listing every
 * repository the installation can see, grouped by owner.
 */

const POPOVER_ID = "repository-switcher"

// MODEL

export const Model = Schema.Struct({
  popover: Popover.Model,
  /** What is typed in the palette's search box. */
  search: Schema.String,
})
export type Model = typeof Model.Type

export type ViewInputs = {
  readonly repositories: ReadonlyArray<RepositoryOverview>
  readonly maybeSelectedId: Option.Option<string>
}

// MESSAGE

export const Message = defineMessageUnion({
  GotPopoverMessage: { message: Popover.Message },
  ChangedSearch: { search: Schema.String },
  ClickedRepository: { repositoryId: Schema.String },
})
export type Message = typeof Message.Type

/** The switcher owns the palette, not the selection. The parent decides what
 *  picking a repository means. */
export const OutMessage = defineMessageUnion({
  SelectedRepository: { repositoryId: Schema.String },
})
export type OutMessage = typeof OutMessage.Type

// INIT

export const init = (): Model =>
  Model.make({ popover: Popover.init({ id: POPOVER_ID }), search: "" })

// UPDATE

const foldPopoverOutMessage = Match.type<Popover.OutMessage>().pipe(
  Match.withReturnType<Update.Step<Model, Message>>(),
  Match.tagsExhaustive({
    Opened: () => (model) => ({ model }),
    // Leaving the search text behind would show the last query the next time
    // the palette opens, with the full list hidden behind it.
    Closed: () => (model) => ({ model: evo(model, { search: () => "" }) }),
  }),
)

const foldPopover = Update.foldChild({
  update: Popover.update,
  read: (model: Model) => Option.some(model.popover),
  write: (model, next) => evo(model, { popover: () => next }),
  toParentMessage: (message) => Message.GotPopoverMessage({ message }),
  foldOutMessage: foldPopoverOutMessage,
})

export type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage>

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    GotPopoverMessage: ({ message }) => foldPopover(model, message),
    ChangedSearch: ({ search }) => ({ model: evo(model, { search: () => search }) }),
    ClickedRepository: ({ repositoryId }) => {
      // Close through the popover's own update so it runs its focus and
      // animation commands rather than having the flag flipped underneath it.
      const closed = Popover.close(model.popover)
      return {
        model: evo(model, { popover: () => closed.model, search: () => "" }),
        commands: FoldkitCommand.mapMessages(closed.commands ?? [], (message) =>
          Message.GotPopoverMessage({ message }),
        ),
        outMessage: OutMessage.SelectedRepository({ repositoryId }),
      }
    },
  })

// SEARCH AND GROUPING

/** `owner/repo`, so typing either side of the slash narrows the list. */
export const matches = (repository: RepositoryOverview, search: string): boolean => {
  const query = search.trim().toLowerCase()
  return query === "" || `${repository.owner}/${repository.repo}`.toLowerCase().includes(query)
}

export type Group = {
  readonly owner: string
  readonly repositories: ReadonlyArray<RepositoryOverview>
}

/** Groups by owner, sorted by owner then repository, so the palette lists the
 *  same thing in the same order every time it opens. */
export const groupByOwner = (
  repositories: ReadonlyArray<RepositoryOverview>,
): ReadonlyArray<Group> => {
  const byOwner = new Map<string, Array<RepositoryOverview>>()
  for (const repository of repositories) {
    const existing = byOwner.get(repository.owner)
    if (existing === undefined) {
      byOwner.set(repository.owner, [repository])
    } else {
      existing.push(repository)
    }
  }
  return [...byOwner.entries()]
    .map(([owner, group]) => ({
      owner,
      repositories: [...group].sort((left, right) => left.repo.localeCompare(right.repo)),
    }))
    .sort((left, right) => left.owner.localeCompare(right.owner))
}

// VIEW

/** The tile letters: the first two of the repository name, uppercased.
 *  `effect` reads as `EF`. */
export const initials = (name: string): string => {
  const letters = name.replace(/[^A-Za-z0-9]/g, "")
  return (letters.slice(0, 2) || name.slice(0, 2)).toUpperCase()
}

const tile = (
  h: HtmlBuilder<Message>,
  repository: RepositoryOverview,
  className?: string,
): Html => {
  const tones = [
    "bg-[#e3d9ff] text-[#54368f] dark:bg-[#55427a] dark:text-[#f0e7ff]",
    "bg-[#d1e7ff] text-[#285579] dark:bg-[#28516d] dark:text-[#e0f1ff]",
    "bg-[#d5ece4] text-[#285d49] dark:bg-[#29594b] dark:text-[#d9fff0]",
  ]
  const tone =
    repository.repositoryId.split("").reduce((sum, char) => sum + char.charCodeAt(0), 1) %
    tones.length
  return h.span(
    [
      h.AriaHidden(true),
      h.Class(
        cn(
          "flex size-8 shrink-0 items-center justify-center rounded-lg text-[11px] font-semibold tracking-tight",
          tones[tone],
          className,
        ),
      ),
    ],
    [initials(repository.repo)],
  )
}

/** Active is the user's enable switch, independent of synchronization and revision state. */
export const statusText = (repository: RepositoryOverview): string =>
  repository.enabled ? "Active" : "Inactive"

const status = (h: HtmlBuilder<Message>, repository: RepositoryOverview): Html =>
  h.span(
    [
      h.Class(
        cn(
          "inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[11px] font-normal",
          repository.enabled ? "text-[#277346] dark:text-[#8acaa1]" : "text-muted-foreground",
        ),
      ),
    ],
    [
      h.span([h.AriaHidden(true), h.Class("size-[5px] rounded-full bg-current")], []),
      statusText(repository),
    ],
  )

const countText = (count: number, singular: string, plural = singular + "s"): string =>
  count + " " + (count === 1 ? singular : plural)

const repositoryRow = (
  h: HtmlBuilder<Message>,
  repository: RepositoryOverview,
  isSelected: boolean,
): Html =>
  CommandPalette.item(h, {
    isSelected,
    onClick: Message.ClickedRepository({ repositoryId: repository.repositoryId }),
    className:
      "my-0.5 cursor-pointer gap-2 rounded-[7px] px-2 py-1.5 hover:bg-accent focus-visible:bg-accent focus-visible:ring-inset",
    attributes: [h.DataAttribute("repository", repository.repositoryId)],
    children: [
      tile(h, repository, "size-8 rounded-[7px] text-[11px]"),
      h.span(
        [h.Class("min-w-0 flex-1")],
        [
          h.span(
            [h.Class("block truncate text-[13px] font-semibold"), h.Title(repository.repo)],
            [repository.repo],
          ),
          h.span(
            [h.Class("text-muted-foreground mt-0.5 flex items-center gap-1.5 text-xs")],
            [
              countText(repository.ruleCount, "rule"),
              h.span([h.AriaHidden(true)], ["·"]),
              countText(repository.policyCount, "policy", "policies"),
            ],
          ),
        ],
      ),
      status(h, repository),
      h.span(
        [h.Class(cn("size-3.5 shrink-0", !isSelected && "invisible")), h.AriaHidden(true)],
        [Icon.view(h, Check, "size-3.5")],
      ),
    ],
  })

const ownerGroup = (
  h: HtmlBuilder<Message>,
  group: Group,
  maybeSelectedId: Option.Option<string>,
): Html =>
  CommandPalette.group(h, {
    heading: group.owner,
    headingClassName: "flex items-center gap-1.5 px-2 py-1.5 text-xs font-medium",
    headingSuffix: h.span([h.Class("opacity-70")], [String(group.repositories.length)]),
    className: "p-0",
    children: group.repositories.map((repository) =>
      repositoryRow(h, repository, Option.contains(maybeSelectedId, repository.repositoryId)),
    ),
  })

const paletteBody = (
  h: HtmlBuilder<Message>,
  { repositories, maybeSelectedId }: ViewInputs,
  search: string,
): ReadonlyArray<Html> => {
  const visible = repositories.filter((repository) => matches(repository, search))
  if (visible.length === 0) {
    return [
      CommandPalette.empty(h, {
        children: [
          repositories.length === 0
            ? "No repositories yet."
            : 'Nothing matches "' + search.trim() + '".',
        ],
      }),
    ]
  }
  return groupByOwner(visible).map((group) => ownerGroup(h, group, maybeSelectedId))
}

const palette = (h: HtmlBuilder<Message>, model: Model, inputs: ViewInputs): Html =>
  CommandPalette.container(h, {
    className: "h-auto w-88 max-w-[calc(100vw-1rem)] rounded-xl! border bg-card p-0 shadow-lg",
    children: [
      CommandPalette.input(h, {
        id: "repository-search",
        ariaLabel: "Find a repository",
        value: model.search,
        placeholder: "Find a repository…",
        wrapperClassName: "border-b px-1.5 py-1",
        groupClassName:
          "h-8! rounded-none! border-0 bg-transparent dark:bg-transparent has-[[data-slot=input-group-control]:focus-visible]:ring-0",
        className: "text-xs",
        onInput: (search) => Message.ChangedSearch({ search }),
      }),
      CommandPalette.list(h, {
        className: "max-h-[min(430px,60dvh)] p-1",
        children: paletteBody(h, inputs, model.search),
      }),
      h.a(
        [h.Href(Routes.connect()), h.Class("block border-t px-3 py-2 text-sm hover:bg-accent")],
        ["+ Connect repository…"],
      ),
      h.div(
        [h.Class("text-muted-foreground flex justify-between border-t px-3 py-1.5 text-[11px]")],
        [
          countText(inputs.repositories.length, "repository", "repositories"),
          h.span(
            [],
            [inputs.repositories.filter((repository) => repository.enabled).length + " active"],
          ),
        ],
      ),
    ],
  })

const triggerLabel = (h: HtmlBuilder<Message>, inputs: ViewInputs): Html => {
  const maybeSelected = Option.flatMap(inputs.maybeSelectedId, (repositoryId) =>
    Array.findFirst(inputs.repositories, (candidate) => candidate.repositoryId === repositoryId),
  )
  return h.span(
    [h.Class("flex w-full min-w-0 items-center gap-2")],
    [
      ...Option.match(maybeSelected, {
        onNone: () => [
          h.span(
            [
              h.AriaHidden(true),
              h.Class(
                "bg-muted flex size-8 shrink-0 items-center justify-center rounded-lg text-[11px]",
              ),
            ],
            ["--"],
          ),
          h.span(
            [h.Class("grid min-w-0 flex-1 text-left")],
            [
              h.span([h.Class("text-muted-foreground text-[11px]")], ["Select one"]),
              h.span([h.Class("truncate text-[13px] font-semibold")], ["No repository"]),
            ],
          ),
        ],
        onSome: (repository) => [
          tile(h, repository),
          h.span(
            [h.Class("grid min-w-0 flex-1 gap-px text-left")],
            [
              h.span(
                [
                  h.Class("text-muted-foreground truncate text-[11px] font-normal"),
                  h.Title(repository.owner),
                ],
                [repository.owner],
              ),
              h.span(
                [h.Class("truncate text-[13px] font-semibold"), h.Title(repository.repo)],
                [repository.repo],
              ),
            ],
          ),
          status(h, repository),
        ],
      }),
      Icon.view(h, ChevronsUpDown, "text-muted-foreground size-3 shrink-0"),
    ],
  )
}

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) =>
  h.submodel({
    slotId: POPOVER_ID,
    model: model.popover,
    view: Popover.view,
    toParentMessage: (message) => Message.GotPopoverMessage({ message }),
    viewInputs: {
      anchor: { placement: "bottom-start", gap: 8, padding: 8 },
      ariaLabel: "Switch repository",
      focusSelector: "[data-slot=command-input]",
      toView: (render) =>
        h.div(
          [],
          [
            Button.view(h, {
              variant: "outline",
              attributes: [...render.button],
              className:
                "h-13 w-full overflow-hidden rounded-[10px] border-sidebar-border bg-card p-2 shadow-xs hover:bg-sidebar-accent dark:bg-card dark:hover:bg-sidebar-accent data-open:bg-sidebar-accent group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:p-0",
              label: triggerLabel(h, inputs),
            }),
            ...(render.isVisible
              ? [
                  h.div([...render.backdrop, h.Class("fixed inset-0 z-40")], []),
                  h.div([...render.panel, h.Class("z-50")], [palette(h, model, inputs)]),
                ]
              : []),
          ],
        ),
    },
  }),
)
