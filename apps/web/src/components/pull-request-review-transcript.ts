import { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import type { LoopRecord } from "@janitor/domain/PullRequestReview/Finding"
import { RunId } from "@janitor/domain/PullRequestReview/Run"
import { RunTranscript, type RunEntry } from "@janitor/domain/PullRequestReview/Settings"
import type * as Prompt from "effect/ai/Prompt"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Command from "foldkit/command"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as Submodel from "foldkit/submodel"
import type * as Update from "foldkit/update"
import { ChevronRight, Download, RotateCw } from "lucide"
import type { RepositoryOverview } from "@janitor/domain/Labeling/Reconciliation"
import { describeDuration, outcome, timestamp, triggerLabel } from "./pull-request-reviews"
import * as Button from "./ui/button"
import { chip } from "./ui/chip"
import * as Page from "./ui/page"
import { ApiClient } from "@/lib/api-client"
import * as Icon from "@/lib/icons"

/**
 * One PR review run's transcript (EFF-2445): the agent session as its run
 * entity committed it, with the findings and thread judgements the loop
 * recorded. Read-only, like the runs list. Everything in it may come from
 * the pull request, so every message is shown as plain, preformatted text;
 * nothing is rendered as HTML or Markdown.
 */

export const Model = Schema.Struct({
  repositoryId: Schema.String,
  runId: Schema.String,
  active: Schema.Boolean,
  transcript: Schema.NullOr(RunTranscript),
  /** The run's entity no longer keeps it. */
  expired: Schema.Boolean,
  loading: Schema.Boolean,
  /** A live update arrived during the fetch in flight, which may have read the run before it. */
  stale: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  /** Fences responses from an earlier run or activation. */
  generation: Schema.Int,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  Activated: { repositoryId: Schema.String, runId: Schema.String, active: Schema.Boolean },
  Polled: {},
  ClickedRefresh: {},
  Loaded: { generation: Schema.Int, transcript: RunTranscript },
  Expired: { generation: Schema.Int },
  Failed: { generation: Schema.Int, reason: Schema.String },
})
export type Message = typeof Message.Type

export const init = (): Model => ({
  repositoryId: "",
  runId: "",
  active: false,
  transcript: null,
  expired: false,
  loading: false,
  stale: false,
  error: null,
  generation: 0,
})

/** The "Download JSON" link: an `href`, so the path is built by hand. */
const transcriptPath = (repositoryId: string, runId: string) =>
  `/api/v1/repositories/${encodeURIComponent(repositoryId)}/pull-request-review/runs/${encodeURIComponent(runId)}/transcript`

const UNREACHABLE = "The transcript could not be loaded. Check your connection and try again."

const MISSING = "This PR review run doesn't exist in this repository."

export const FetchTranscript = Command.define("FetchPullRequestReviewTranscript", {
  args: { repositoryId: Schema.String, runId: Schema.String, generation: Schema.Int },
  messages: [Message.Loaded, Message.Expired, Message.Failed],
  execute: ({ repositoryId, runId, generation }) =>
    // The run id comes from the URL, so a malformed one is a missing run.
    !Schema.is(RunId)(runId)
      ? Effect.succeed(Message.Failed({ generation, reason: MISSING }))
      : ApiClient.use((api) =>
          api.pullRequestReview.getRunTranscript({
            params: { repositoryId: GitHubRepositoryDatabaseId.make(repositoryId), runId },
          }),
        ).pipe(
          Effect.timeout("15 seconds"),
          Effect.map((transcript) => Message.Loaded({ generation, transcript })),
          Effect.catchTags({
            RepositoryNotFound: () =>
              Effect.succeed(Message.Failed({ generation, reason: MISSING })),
            RunNotFound: () => Effect.succeed(Message.Failed({ generation, reason: MISSING })),
            TranscriptExpired: () => Effect.succeed(Message.Expired({ generation })),
          }),
          Effect.orElseSucceed(() => Message.Failed({ generation, reason: UNREACHABLE })),
        ),
})

type Return = Update.Return<Model, Message, ApiClient>

const fetch = (model: Model): Return => {
  if (!model.active || model.loading) return { model }
  return {
    model: { ...model, loading: true, stale: false, error: null },
    commands: [
      FetchTranscript({
        repositoryId: model.repositoryId,
        runId: model.runId,
        generation: model.generation,
      }),
    ],
  }
}

/** Only a running run's transcript still grows. */
const polled = (model: Model): Return =>
  model.transcript?.run.status === "running" ? fetch(model) : { model }

export const update = (model: Model, message: Message): Return =>
  Message.match(message, {
    Activated: ({ repositoryId, runId, active }) => {
      if (model.repositoryId === repositoryId && model.runId === runId && model.active === active)
        return { model }
      const next =
        model.repositoryId === repositoryId && model.runId === runId
          ? { ...model, active }
          : { ...init(), generation: model.generation, repositoryId, runId, active }
      // Fence responses when leaving and refresh on return.
      const fenced = { ...next, loading: false, stale: false, generation: next.generation + 1 }
      return active ? fetch(fenced) : { model: fenced }
    },
    // Kept for when the fetch in flight settles, rather than dropped.
    Polled: () => (model.loading ? { model: { ...model, stale: true } } : polled(model)),
    ClickedRefresh: () => fetch(model),
    Loaded: ({ generation, transcript }) => {
      if (generation !== model.generation || !model.active) return { model }
      const next = {
        ...model,
        transcript,
        expired: false,
        loading: false,
        stale: false,
        error: null,
      }
      return model.stale ? polled(next) : { model: next }
    },
    Expired: ({ generation }) =>
      generation !== model.generation
        ? { model }
        : {
            model: {
              ...model,
              transcript: null,
              expired: true,
              loading: false,
              stale: false,
              error: null,
            },
          },
    Failed: ({ generation, reason }) =>
      generation !== model.generation
        ? { model }
        : { model: { ...model, loading: false, stale: false, error: reason } },
  })

// VIEW

const summaryClass =
  "flex cursor-pointer list-none items-center gap-1.5 text-body-sm font-medium text-ink-muted marker:hidden [&::-webkit-details-marker]:hidden"

/** Untrusted text, verbatim: mono, preformatted, never parsed. */
const verbatim = <M>(h: HtmlBuilder<M>, text: string) =>
  h.pre(
    [
      h.Class(
        "max-h-96 overflow-auto rounded-xs border border-border-subtle bg-surface-muted p-2 font-mono text-mono-sm whitespace-pre-wrap wrap-anywhere",
      ),
    ],
    [text],
  )

/** Prose the model or the pull request wrote, verbatim but in the body font. */
const prose = <M>(h: HtmlBuilder<M>, text: string) =>
  h.pre([h.Class("font-sans text-body-md whitespace-pre-wrap wrap-anywhere")], [text])

/** A collapsed block: tool calls and results are long, and the prose around them says what they did. */
const disclosure = <M>(h: HtmlBuilder<M>, title: string, body: Html) =>
  h.details(
    [h.Class("group/disclosure")],
    [
      h.summary(
        [h.Class(summaryClass)],
        [
          Icon.view(
            h,
            ChevronRight,
            "size-3.5 shrink-0 transition-transform group-open/disclosure:rotate-90",
          ),
          title,
        ],
      ),
      h.div([h.Class("mt-1.5")], [body]),
    ],
  )

const json = (value: unknown) => {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

const partView = <M>(h: HtmlBuilder<M>, part: Prompt.Part): Html => {
  switch (part.type) {
    case "text":
      return prose(h, part.text)
    case "reasoning":
      // The model's working, not the review's conclusion.
      return disclosure(h, "Reasoning", verbatim(h, part.text))
    case "file":
      return h.p([h.Class("text-body-sm text-ink-muted")], [`File · ${part.mediaType}`])
    case "tool-call":
      return disclosure(h, `Tool call · ${part.name}`, verbatim(h, json(part.params)))
    case "tool-result":
      return disclosure(
        h,
        `Tool result · ${part.name}${part.isFailure ? " · failed" : ""}`,
        verbatim(h, json(part.result)),
      )
    case "tool-approval-request":
    case "tool-approval-response":
      return h.p([h.Class("text-body-sm text-ink-muted")], [`Tool approval · ${part.approvalId}`])
  }
}

const roleLabel: Record<Prompt.Message["role"], string> = {
  system: "System",
  user: "Janitor",
  assistant: "Agent",
  tool: "Tool",
}

const messageView = <M>(h: HtmlBuilder<M>, message: Prompt.Message, index: number) =>
  h.li(
    [
      h.Class("flex flex-col gap-2 rounded-md border border-border bg-card p-3"),
      h.DataAttribute("role", message.role),
    ],
    [
      h.div(
        [h.Class("flex items-center gap-2 text-caption font-medium text-ink-subtle")],
        [
          h.span([], [roleLabel[message.role]]),
          h.span([h.Class("font-mono tabular-nums")], [`#${index + 1}`]),
        ],
      ),
      ...(typeof message.content === "string"
        ? [prose(h, message.content)]
        : message.content.map((part) => partView(h, part))),
    ],
  )

const recordView = <M>(h: HtmlBuilder<M>, record: LoopRecord) =>
  record._tag === "FindingReported"
    ? h.li(
        [h.Class("flex flex-col gap-1.5 py-2")],
        [
          h.div(
            [h.Class("flex items-center gap-2")],
            [
              chip(h, {
                variant: record.finding.severity === "blocking" ? "danger" : "neutral",
                children: [record.finding.severity],
              }),
              h.span(
                [h.Class("min-w-0 truncate font-mono text-mono-sm")],
                [
                  `${record.finding.path}:${record.finding.startLine}${
                    record.finding.endLine === record.finding.startLine
                      ? ""
                      : `-${record.finding.endLine}`
                  }`,
                ],
              ),
            ],
          ),
          prose(h, record.finding.comment),
        ],
      )
    : h.li(
        [h.Class("flex flex-col gap-1.5 py-2")],
        [
          h.div(
            [h.Class("flex items-center gap-2")],
            [
              chip(h, {
                variant: "neutral",
                children: [record.judgement.judgement.replace("_", " ")],
              }),
              h.span([h.Class("min-w-0 truncate font-mono text-mono-sm")], [record.threadId]),
            ],
          ),
          record.judgement.note === undefined ? h.empty : prose(h, record.judgement.note),
        ],
      )

const runSummary = <M>(h: HtmlBuilder<M>, transcript: RunTranscript) => {
  const { run } = transcript
  const { label, variant } = outcome(run)
  return Page.kvList(h, [
    Page.kv(h, "Outcome", [chip(h, { variant, children: [label] })], { mono: false }),
    Page.kv(h, "Trigger", triggerLabel(run.trigger), { mono: false }),
    Page.kv(h, "Head", run.headSha.slice(0, 7)),
    Page.kv(h, "Started", `${timestamp(run.startedAt)} UTC`),
    Page.kv(h, "Duration", duration(run)),
    Page.kv(h, "Resumes", String(transcript.resumeCount)),
    Page.kv(
      h,
      "Deadline",
      transcript.interrupted
        ? "Interrupted at the deadline"
        : transcript.steered
          ? "Told to wrap up"
          : "Not reached",
      { mono: false },
    ),
    ...(transcript.errorCategory === null
      ? []
      : [Page.kv(h, "Error", transcript.errorCategory.replaceAll("_", " "))]),
  ])
}

const duration = (run: RunEntry) =>
  run.finishedAt === null
    ? "—"
    : describeDuration(
        DateTime.toEpochMillis(run.finishedAt) - DateTime.toEpochMillis(run.startedAt),
      )

const kept = (transcript: RunTranscript) =>
  transcript.expiresAt === null
    ? "Kept while the run is going, then for the retention period after it ends."
    : `Kept until ${timestamp(transcript.expiresAt)} UTC.`

const status = <M>(h: HtmlBuilder<M>, text: string) =>
  h.p(
    [
      h.Role("status"),
      h.Class("rounded-lg border border-border bg-card px-4 py-3 text-body-sm text-ink-muted"),
    ],
    [text],
  )

export const view = Submodel.defineView<
  Model,
  Message,
  { repository: RepositoryOverview | undefined }
>((model, { repository }, h) => {
  const { transcript } = model
  const title =
    transcript === null
      ? "PR review transcript"
      : h.h1(
          [h.Class("min-w-0")],
          [
            repository === undefined
              ? h.span([h.Class("font-mono")], [`#${transcript.run.number}`])
              : h.a(
                  [
                    h.Href(
                      `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/pull/${transcript.run.number}`,
                    ),
                    h.Target("_blank"),
                    h.Rel("noopener noreferrer"),
                    h.Class("font-mono hover:underline"),
                  ],
                  [`#${transcript.run.number}`],
                ),
            " ",
            transcript.run.title,
          ],
        )
  const actions = [
    h.a(
      [
        h.Href(transcriptPath(model.repositoryId, model.runId)),
        h.Download(`pull-request-review-${model.runId}.json`),
        h.Class(
          "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-body-md text-ink-muted hover:bg-surface-muted",
        ),
      ],
      [Icon.view(h, Download, "size-4"), "Download JSON"],
    ),
    Button.view(h, {
      variant: "secondary",
      label: h.span([h.Class("contents")], [Icon.view(h, RotateCw, "size-4"), "Refresh"]),
      onClick: Message.ClickedRefresh(),
      isDisabled: model.loading,
    }),
  ]
  const error =
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
              onClick: Message.ClickedRefresh(),
              isDisabled: model.loading,
            }),
          ],
        )
  const body =
    transcript !== null
      ? transcript.messages.length === 0
        ? status(
            h,
            transcript.run.status === "running"
              ? "Nothing committed yet. The agent's first step is still running."
              : "Nothing was committed. The run ended before the agent finished a step.",
          )
        : h.ol(
            [h.Class("flex flex-col gap-3"), h.AriaLabel("Messages")],
            transcript.messages.map((message, index) => messageView(h, message, index)),
          )
      : model.expired
        ? status(
            h,
            "This transcript is no longer kept. A run's transcript is dropped once the retention period after it ended has passed, and at once when it was cancelled.",
          )
        : model.error === null
          ? status(h, "Loading the transcript…")
          : h.empty
  return Page.layout(h, {
    attributes: [h.AriaLabel("PR review transcript")],
    main: [
      Page.header(h, {
        title,
        lede:
          transcript === null
            ? "The agent session of one PR review run, as it was committed."
            : kept(transcript),
        actions: transcript === null ? [] : actions,
      }),
      error,
      body,
    ],
    ...(transcript === null
      ? {}
      : {
          inspector: [
            Page.inspectorCard(h, { heading: "Run", children: [runSummary(h, transcript)] }),
            Page.inspectorCard(h, {
              heading: "Findings and thread judgements",
              children: [
                transcript.records.length === 0
                  ? h.p([h.Class("text-body-sm text-ink-muted")], ["None recorded."])
                  : h.ul(
                      [h.Class("flex flex-col divide-y divide-border-subtle")],
                      transcript.records.map((record) => recordView(h, record)),
                    ),
              ],
            }),
          ],
        }),
  })
})
