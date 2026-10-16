import { RepositorySettings } from "@janitor/domain/PullRequestReview/Settings"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage"
import * as Command from "foldkit/command"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as Submodel from "foldkit/submodel"
import type * as Update from "foldkit/update"
import * as Button from "@/components/ui/button"
import { chip } from "@/components/ui/chip"
import { panel, panelHeader } from "@/components/ui/panel"
import { readFailure, reasonOf, request } from "@/lib/api"

/**
 * The "PR review" panel on a repository's Settings page (EFF-1930), next to
 * AI classification. Any teammate who can open the page can turn it on or
 * off. Without the deployment's model endpoint the panel still shows, says
 * so, and only lets someone turn an enabled repository off.
 */

export const endpoint = (repositoryId: string) =>
  `/api/v1/repositories/${encodeURIComponent(repositoryId)}/pull-request-review`

export const Model = Schema.Struct({
  repositoryId: Schema.String,
  /** Whether the Settings page is showing, so live changes refetch only then. */
  active: Schema.Boolean,
  settings: Schema.NullOr(RepositorySettings),
  error: Schema.NullOr(Schema.String),
  loading: Schema.Boolean,
  saving: Schema.Boolean,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  /** The Settings page opened for a repository; loads its settings. */
  Opened: { repositoryId: Schema.String },
  /** The Settings page closed; keeps the settings for the next visit. */
  Closed: {},
  /** Something changed on the server; refetches while the page shows. */
  Polled: {},
  Loaded: { settings: RepositorySettings },
  Failed: { repositoryId: Schema.String, reason: Schema.String },
  ClickedRetry: {},
  ClickedToggle: {},
  Saved: { settings: RepositorySettings },
  FailedSave: { repositoryId: Schema.String, reason: Schema.String },
})
export type Message = typeof Message.Type

export const init = (): Model => ({
  repositoryId: "",
  active: false,
  settings: null,
  error: null,
  loading: false,
  saving: false,
})

export const FetchSettings = Command.define("FetchPullRequestReviewSettings", {
  args: { repositoryId: Schema.String },
  messages: [Message.Loaded, Message.Failed],
  execute: ({ repositoryId }) =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get(endpoint(repositoryId))
      if (response.status !== 200)
        return yield* readFailure(response, "PR review settings could not be loaded.")
      const settings = yield* HttpIncomingMessage.schemaBodyJson(RepositorySettings)(response)
      return Message.Loaded({ settings })
    }).pipe(
      Effect.timeout("15 seconds"),
      Effect.catch((error) =>
        Effect.succeed(Message.Failed({ repositoryId, reason: reasonOf(error) })),
      ),
    ),
})

export const SetSettings = Command.define("SetPullRequestReviewSettings", {
  args: { repositoryId: Schema.String, enabled: Schema.Boolean },
  messages: [Message.Saved, Message.FailedSave],
  execute: ({ repositoryId, enabled }) =>
    request("PUT", endpoint(repositoryId), { enabled }).pipe(
      Effect.flatMap(HttpIncomingMessage.schemaBodyJson(RepositorySettings)),
      Effect.map((settings) => Message.Saved({ settings })),
      Effect.catch((error) =>
        Effect.succeed(Message.FailedSave({ repositoryId, reason: reasonOf(error) })),
      ),
    ),
})

type Return = Update.Return<Model, Message, HttpClient.HttpClient>

const fetch = (model: Model): Return =>
  model.loading
    ? { model }
    : {
        model: { ...model, loading: true },
        commands: [FetchSettings({ repositoryId: model.repositoryId })],
      }

export const update = (model: Model, message: Message): Return =>
  Message.match(message, {
    Opened: ({ repositoryId }) =>
      repositoryId === model.repositoryId
        ? fetch({ ...model, active: true })
        : fetch({ ...init(), repositoryId, active: true }),
    Closed: () => ({ model: { ...model, active: false } }),
    Polled: () => (model.active ? fetch(model) : { model }),
    Loaded: ({ settings }) =>
      settings.repositoryId !== model.repositoryId
        ? { model }
        : { model: { ...model, settings, loading: false, error: null } },
    Failed: ({ repositoryId, reason }) =>
      repositoryId !== model.repositoryId
        ? { model }
        : { model: { ...model, loading: false, error: reason } },
    ClickedRetry: () => fetch({ ...model, error: null }),
    ClickedToggle: () => {
      const settings = model.settings
      if (settings === null || model.saving || !canToggle(settings)) return { model }
      return {
        model: { ...model, saving: true, error: null },
        commands: [SetSettings({ repositoryId: model.repositoryId, enabled: !settings.enabled })],
      }
    },
    Saved: ({ settings }) =>
      settings.repositoryId !== model.repositoryId
        ? { model }
        : { model: { ...model, settings, saving: false, error: null } },
    FailedSave: ({ repositoryId, reason }) =>
      repositoryId !== model.repositoryId
        ? { model }
        : { model: { ...model, saving: false, error: reason } },
  })

/** An unavailable deployment can still turn an enabled repository off. */
const canToggle = (settings: RepositorySettings) =>
  settings.enabled || settings.deployment.available

const description = (settings: RepositorySettings): string =>
  settings.enabled
    ? `Enabled. The Janitor reviews pull requests when they open or change, and on /janitor, with ${settings.deployment.model}. It posts a GitHub review and reports the janitor/review check. Disabling cancels the reviews in progress straight away.`
    : `Disabled. Pull requests in this repository are not reviewed. Enabling reviews them when they open or change, and on /janitor, with ${settings.deployment.model}. Private repositories can't be enabled.`

const body = (h: HtmlBuilder<Message>, model: Model, settings: RepositorySettings | null): Html => {
  if (settings === null)
    return model.error === null
      ? h.p([h.Class("text-body-md text-ink-muted")], ["Loading"])
      : h.div(
          [
            h.Role("alert"),
            h.Class("flex flex-wrap items-center gap-2 text-body-sm text-destructive"),
          ],
          [
            model.error,
            Button.view(h, {
              label: "Retry PR review",
              variant: "secondary",
              size: "sm",
              onClick: Message.ClickedRetry(),
              isDisabled: model.loading,
            }),
          ],
        )
  return h.div(
    [h.Class("flex flex-col gap-2")],
    [
      h.div(
        [h.Class("flex items-center gap-2")],
        [
          chip(h, {
            variant: settings.enabled ? "success" : "neutral",
            children: [settings.enabled ? "Enabled" : "Disabled"],
          }),
        ],
      ),
      settings.deployment.available
        ? h.empty
        : h.div(
            [h.Class("flex flex-col gap-1")],
            [
              h.p([h.Class("text-body-md font-medium")], ["Unavailable in this deployment"]),
              h.p(
                [h.Class("text-body-md text-ink-muted")],
                [
                  settings.enabled
                    ? "The server has no PR review key, so no reviews run. You can still disable it here."
                    : "The server has no PR review key, so PR review can't be enabled here.",
                ],
              ),
            ],
          ),
      h.p([h.Class("text-body-md text-ink-muted")], [description(settings)]),
      model.error === null
        ? h.empty
        : h.p([h.Role("alert"), h.Class("text-body-sm text-destructive")], [model.error]),
    ],
  )
}

export const view = Submodel.defineView<Model, Message>((model, h) => {
  const settings = model.settings
  return panel(h, {
    flush: true,
    attributes: [
      h.DataAttribute(
        "pull-request-review",
        settings === null ? "unknown" : settings.enabled ? "enabled" : "disabled",
      ),
      h.AriaLabel("PR review"),
    ],
    children: [
      panelHeader(h, {
        title: "PR review",
        ...(settings === null
          ? {}
          : { meta: `${settings.deployment.model} · ${settings.deployment.reasoningEffort}` }),
        actions:
          settings === null
            ? []
            : [
                Button.view(h, {
                  variant: settings.enabled ? "destructive" : "secondary",
                  size: "sm",
                  onClick: Message.ClickedToggle(),
                  isDisabled: model.saving || !canToggle(settings),
                  label: model.saving
                    ? settings.enabled
                      ? "Disabling…"
                      : "Enabling…"
                    : settings.enabled
                      ? "Disable"
                      : "Enable",
                  attributes: [h.DataAttribute("action", "toggle-pull-request-review")],
                }),
              ],
      }),
      h.div([h.Class("flex flex-col gap-2 px-4 py-3")], [body(h, model, settings)]),
    ],
  })
})
