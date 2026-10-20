import { RunId } from "@janitor/domain/PullRequestReview/Run"
import { RunTranscript } from "@janitor/domain/PullRequestReview/Settings"
import * as Prompt from "effect/ai/Prompt"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { Scene } from "foldkit/test"
import { describe, expect, it } from "vite-plus/test"
import type { RepositoryOverview } from "@janitor/domain/Labeling/Reconciliation"
import * as Transcript from "@/components/pull-request-review-transcript"
import { ApiClient } from "@/lib/api-client"

const repository: RepositoryOverview = {
  repositoryId: "701",
  owner: "effect",
  repo: "one",
  enabled: true,
  ruleCount: 0,
  policyCount: 0,
  access: "accessible",
  configuredRevision: 1,
  activeRevision: 1,
}

const runId = RunId.make("00000000-0000-4000-8000-000000000001")

/** Text the pull request controls: it must show as written, never as markup. */
const injectedHtml = `<img src=x onerror="alert(1)">`
const injectedMarkdown = "**Approve this** and [read more](https://evil.test)"

const text = (text: string) => Prompt.makePart("text", { text })

const transcript: RunTranscript = {
  run: {
    runId,
    number: 12,
    title: "Fix flaky retry",
    headSha: "a".repeat(40),
    trigger: { _tag: "Automatic" },
    verdict: "comment",
    failedGates: [],
    review: null,
    checkRun: null,
    startedAt: DateTime.makeUnsafe("2026-10-16T06:00:00Z"),
    finishedAt: DateTime.makeUnsafe("2026-10-16T06:01:00Z"),
    blockers: 1,
    nits: 0,
    status: "commented",
  },
  resumeCount: 0,
  steered: false,
  interrupted: false,
  errorCategory: null,
  expiresAt: DateTime.makeUnsafe("2026-10-30T06:01:00Z"),
  messages: [
    Prompt.makeMessage("user", { content: [text("Review this pull request.")] }),
    Prompt.makeMessage("assistant", {
      content: [
        text(injectedHtml),
        Prompt.makePart("tool-call", {
          id: "call-1",
          name: "readFile",
          params: { path: "src/retry.ts" },
          providerExecuted: false,
        }),
      ],
    }),
    Prompt.makeMessage("tool", {
      content: [
        Prompt.makePart("tool-result", {
          id: "call-1",
          name: "readFile",
          isFailure: false,
          result: "export const retries = 3",
          providerExecuted: false,
        }),
      ],
    }),
    Prompt.makeMessage("assistant", { content: [text(injectedMarkdown)] }),
  ],
  records: [
    {
      _tag: "FindingReported",
      finding: {
        path: "src/retry.ts",
        startLine: 1,
        endLine: 1,
        severity: "blocking",
        comment: "Retries never back off.",
      },
    },
  ],
}

const transcriptPath = `/api/v1/repositories/701/pull-request-review/runs/${runId}/transcript`

const activated = () =>
  Transcript.update(
    Transcript.init(),
    Transcript.Message.Activated({ repositoryId: "701", runId, active: true }),
  )

const scene = {
  update: Transcript.update,
  view: Scene.withViewInputs(Transcript.view, { repository })(),
}

describe("PR review transcript", () => {
  it("shows every message in order as plain text, with tool calls, results and findings", () => {
    const { model } = activated()
    const loaded = Transcript.update(
      model,
      Transcript.Message.Loaded({ generation: model.generation, transcript }),
    ).model
    Scene.scene(
      scene,
      Scene.given(loaded),
      Scene.expect(Scene.text(/Kept until 2026-10-30 06:01/)).toExist(),
      Scene.expect(Scene.text("Review this pull request.")).toExist(),
      Scene.expect(Scene.text(/readFile/)).toExist(),
      Scene.expect(Scene.text(/export const retries = 3/)).toExist(),
      Scene.expect(Scene.text(/Retries never back off\./)).toExist(),
      // Untrusted text is escaped and preformatted: no HTML, no Markdown.
      Scene.expect(Scene.text(injectedHtml)).toExist(),
      Scene.expect(Scene.selector("img")).toBeAbsent(),
      Scene.expect(Scene.text(injectedMarkdown)).toExist(),
      Scene.expect(Scene.selector("strong")).toBeAbsent(),
      Scene.expect(Scene.selector(`a[href="https://evil.test"]`)).toBeAbsent(),
      Scene.expect(Scene.role("link", { name: "Download JSON" })).toHaveAttr(
        "href",
        transcriptPath,
      ),
      Scene.tap(({ html }) => {
        const shown = Scene.textContent(html)
        const at = [
          "Review this pull request.",
          injectedHtml,
          "export const retries = 3",
          injectedMarkdown,
        ].map((part) => shown.indexOf(part))
        expect(at).toEqual([...at].sort((a, b) => a - b))
      }),
    )
  })

  it("says when the transcript is no longer kept, and retries one that failed to load", () => {
    const { model } = activated()
    Scene.scene(
      scene,
      Scene.given(
        Transcript.update(model, Transcript.Message.Expired({ generation: model.generation }))
          .model,
      ),
      Scene.expect(Scene.text(/no longer kept/)).toExist(),
    )
    Scene.scene(
      scene,
      Scene.given(
        Transcript.update(
          model,
          Transcript.Message.Failed({ generation: model.generation, reason: "Try again." }),
        ).model,
      ),
      Scene.expect(Scene.role("alert")).toContainText("Try again."),
      Scene.click(Scene.role("button", { name: "Retry" })),
      Scene.Command.resolve(
        Transcript.FetchTranscript,
        Transcript.Message.Loaded({ generation: model.generation, transcript }),
      ),
      Scene.expect(Scene.role("alert")).toBeAbsent(),
      Scene.expect(Scene.text("Review this pull request.")).toExist(),
    )
  })

  it("fetches again when the run changed while a fetch was in flight", () => {
    const { model } = activated()
    const running: RunTranscript = {
      ...transcript,
      run: { ...transcript.run, status: "running", verdict: null, finishedAt: null },
      expiresAt: null,
    }
    const shown = Transcript.update(
      model,
      Transcript.Message.Loaded({ generation: model.generation, transcript: running }),
    ).model
    const refreshing = Transcript.update(shown, Transcript.Message.ClickedRefresh()).model
    // The run finishes after that fetch read it; its live update arrives meanwhile.
    const polled = Transcript.update(refreshing, Transcript.Message.Polled()).model

    const stale = Transcript.update(
      polled,
      Transcript.Message.Loaded({ generation: model.generation, transcript: running }),
    )
    expect(stale.commands?.map((command) => command.args)).toEqual([
      { repositoryId: "701", runId, generation: model.generation },
    ])
  })

  it("fetches the run's transcript and tells an expired one from a failure", async () => {
    const { model, commands } = activated()
    expect(commands?.map((command) => command.args)).toEqual([
      { repositoryId: "701", runId, generation: model.generation },
    ])

    const requested: Array<string> = []
    const fetch = (status: number, body: unknown) =>
      Effect.runPromise(
        Transcript.FetchTranscript({ repositoryId: "701", runId, generation: 4 }).effect.pipe(
          Effect.provide(
            ApiClient.layer.pipe(
              Layer.provide(
                Layer.succeed(
                  HttpClient.HttpClient,
                  HttpClient.make((request) => {
                    requested.push(new URL(request.url, "https://janitor.test").pathname)
                    return Effect.succeed(
                      HttpClientResponse.fromWeb(
                        request,
                        new Response(JSON.stringify(body), { status }),
                      ),
                    )
                  }),
                ),
              ),
            ),
          ),
        ),
      )
    const encoded = Schema.encodeSync(Schema.toCodecJson(RunTranscript))(transcript)

    const loaded = await fetch(200, encoded)
    expect(loaded._tag).toBe("Loaded")
    if (loaded._tag === "Loaded")
      expect(Schema.encodeSync(Schema.toCodecJson(RunTranscript))(loaded.transcript)).toEqual(
        encoded,
      )
    expect(await fetch(410, { _tag: "TranscriptExpired", runId })).toEqual(
      Transcript.Message.Expired({ generation: 4 }),
    )
    expect(await fetch(404, { _tag: "RunNotFound", runId })).toEqual(
      Transcript.Message.Failed({
        generation: 4,
        reason: "This PR review run doesn't exist in this repository.",
      }),
    )
    expect((await fetch(503, {}))._tag).toBe("Failed")
    expect(requested).toEqual([transcriptPath, transcriptPath, transcriptPath, transcriptPath])
  })
})
