import { PrivateRepository } from "@janitor/domain/Api/PullRequestReview.prototype"
import { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { RepositorySettings } from "@janitor/domain/PullRequestReview/Settings"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { Scene } from "foldkit/test"
import { describe, expect, it } from "vite-plus/test"
import * as Settings from "@/components/pull-request-review-settings"
import { ApiClient } from "@/lib/api-client.prototype"

/** PROTOTYPE (EFF-2304): the real derived client over a stubbed HttpClient. */
const overHttp = (client: HttpClient.HttpClient) =>
  Effect.provide(ApiClient.layer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))))

const disabled = RepositorySettings.make({
  repositoryId: GitHubRepositoryDatabaseId.make("701"),
  enabled: false,
  deployment: { available: true, model: "openai/gpt-6.1-sol", reasoningEffort: "medium" },
})
const enabled = RepositorySettings.make({ ...disabled, enabled: true })
const unavailable = RepositorySettings.make({
  ...disabled,
  deployment: { ...disabled.deployment, available: false },
})

const loaded = (settings: RepositorySettings): Settings.Model => {
  const opened = Settings.update(
    Settings.init(),
    Settings.Message.Opened({ repositoryId: "701" }),
  ).model
  return Settings.update(opened, Settings.Message.Loaded({ settings })).model
}

const panel = { update: Settings.update, view: Settings.view }

describe("PR review settings", () => {
  it("shows the deployment's model and the flag, and disables the button when unavailable", () => {
    Scene.scene(
      panel,
      Scene.given(loaded(disabled)),
      Scene.expect(Scene.text("PR review")).toExist(),
      Scene.expect(Scene.text("openai/gpt-6.1-sol · medium")).toExist(),
      Scene.expect(Scene.text("Disabled")).toExist(),
      Scene.expect(Scene.role("button", { name: "Enable" })).toBeEnabled(),
    )
    Scene.scene(
      panel,
      Scene.given(loaded(enabled)),
      Scene.expect(Scene.text("Enabled")).toExist(),
      Scene.expect(Scene.role("button", { name: "Disable" })).toBeEnabled(),
    )
    Scene.scene(
      panel,
      Scene.given(loaded(unavailable)),
      Scene.expect(Scene.text("PR review")).toExist(),
      Scene.expect(Scene.text("Unavailable in this deployment")).toExist(),
      Scene.expect(Scene.role("button", { name: "Enable" })).toBeDisabled(),
    )
  })

  it("enables with a PUT of the flag and shows the saved state", async () => {
    Scene.scene(
      panel,
      Scene.given(loaded(disabled)),
      Scene.click(Scene.role("button", { name: "Enable" })),
      Scene.expect(Scene.role("button", { name: "Enabling…" })).toBeDisabled(),
      Scene.Command.resolve(
        Settings.SetSettings({ repositoryId: "701", enabled: true }),
        Settings.Message.Saved({ settings: enabled }),
      ),
      Scene.expect(Scene.role("button", { name: "Disable" })).toBeEnabled(),
    )

    const sent: Array<{ method: string; url: string; body: unknown }> = []
    const client = HttpClient.make((request) => {
      sent.push({
        method: request.method,
        url: new URL(request.url, "https://janitor.test").pathname,
        body:
          request.body._tag === "Uint8Array"
            ? JSON.parse(new TextDecoder().decode(request.body.body))
            : undefined,
      })
      const body = Schema.encodeSync(Schema.toCodecJson(RepositorySettings))(enabled)
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status: 200 })),
      )
    })
    const message = await Effect.runPromise(
      Settings.SetSettings({ repositoryId: "701", enabled: true }).effect.pipe(overHttp(client)),
    )
    expect(sent).toEqual([
      {
        method: "PUT",
        url: "/api/v1/repositories/701/pull-request-review",
        body: { enabled: true },
      },
    ])
    expect(message).toEqual(Settings.Message.Saved({ settings: enabled }))
  })

  it("shows the private-repository copy when the server refuses (stubbed on the wire)", async () => {
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ _tag: "PrivateRepository" }), {
            status: 409,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    )
    const message = await Effect.runPromise(
      Settings.SetSettings({ repositoryId: "701", enabled: true }).effect.pipe(overHttp(client)),
    )
    expect(message).toEqual(
      Settings.Message.FailedSave({
        repositoryId: "701",
        reason: "PR review can't be enabled for a private repository.",
      }),
    )
  })

  it("shows the private-repository copy when the server refuses (stubbed client)", async () => {
    // PROTOTYPE (EFF-2304): the other option, a hand-written client. It needs
    // a cast, since the client's type covers every group, and it pins nothing
    // about the wire.
    const api = {
      pullRequestReview: { setSettings: () => Effect.fail(new PrivateRepository()) },
    } as unknown as ApiClient["Service"]
    const message = await Effect.runPromise(
      Settings.SetSettings({ repositoryId: "701", enabled: true }).effect.pipe(
        Effect.provideService(ApiClient, api),
      ),
    )
    expect(message).toEqual(
      Settings.Message.FailedSave({
        repositoryId: "701",
        reason: "PR review can't be enabled for a private repository.",
      }),
    )
  })
})
