// The one client through which Janitor speaks to the session runner.
//
// Every response is classified into the protocol's distinct outcomes:
// incompatible protocol, stale generation, missing session, blocked
// initialization and retryable transport failure. Callers never see raw HTTP.
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import {
  AdmitResult,
  CleanupResult,
  CreateSessionResult,
  EventsRead,
  Inspection,
  MaintenanceResult,
  RUNNER_PROTOCOL_HEADER,
  RUNNER_PROTOCOL_VERSION,
  RunnerErrorBody,
  type AdmitInputRequest,
  type AgentSessionId,
  type CreateSessionRequest,
  type RunnerErrorCode,
} from "./RunnerProtocol.ts"

export class RunnerClientError extends Data.TaggedError("RunnerClientError")<{
  readonly code: RunnerErrorCode
  readonly message: string
  readonly reason?: string | undefined
  readonly status?: number | undefined
}> {
  /** Transport failures may be retried with the same identities; nothing else may. */
  get retryable() {
    return this.code === "transport"
  }
}

export interface RunnerClientConfig {
  readonly baseUrl: string
  readonly token: Redacted.Redacted
  readonly timeout?: Duration.Duration | undefined
}

export const EVENT_PAGE_LIMIT = 200

export class RunnerClient extends Context.Service<
  RunnerClient,
  {
    readonly createSession: (
      sessionId: AgentSessionId,
      request: CreateSessionRequest,
    ) => Effect.Effect<CreateSessionResult, RunnerClientError>
    readonly admitInput: (
      sessionId: AgentSessionId,
      request: AdmitInputRequest,
    ) => Effect.Effect<AdmitResult, RunnerClientError>
    readonly inspect: (sessionId: AgentSessionId) => Effect.Effect<Inspection, RunnerClientError>
    readonly readEvents: (
      sessionId: AgentSessionId,
      after: number,
      limit?: number,
    ) => Effect.Effect<EventsRead, RunnerClientError>
    readonly maintenance: (
      sessionId: AgentSessionId,
      request: { readonly hold: boolean; readonly epoch: number },
    ) => Effect.Effect<MaintenanceResult, RunnerClientError>
    readonly cleanup: (
      sessionId: AgentSessionId,
      generation: number,
    ) => Effect.Effect<CleanupResult, RunnerClientError>
  }
>()("@janitor/cluster/Agent/RunnerClient") {
  static readonly layer = (config: RunnerClientConfig) =>
    Layer.effect(
      this,
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient
        const timeout = config.timeout ?? Duration.seconds(20)
        const base = config.baseUrl.replace(/\/$/, "")
        const decodeError = Schema.decodeUnknownOption(RunnerErrorBody)
        const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

        const transport = (message: string, status?: number) =>
          new RunnerClientError({ code: "transport", message, status })

        const send = <A>(
          method: "GET" | "PUT" | "POST" | "DELETE",
          path: string,
          body: unknown,
          schema: Schema.Codec<A, unknown>,
        ) =>
          Effect.gen(function* () {
            let request = HttpClientRequest.make(method)(`${base}${path}`).pipe(
              HttpClientRequest.bearerToken(Redacted.value(config.token)),
              HttpClientRequest.setHeaders({
                [RUNNER_PROTOCOL_HEADER]: String(RUNNER_PROTOCOL_VERSION),
                accept: "application/json",
              }),
            )
            if (body !== undefined)
              request = yield* HttpClientRequest.bodyJson(request, body).pipe(
                Effect.mapError((cause) =>
                  transport(`Could not encode runner request: ${cause.message}`),
                ),
              )
            const response = yield* http.execute(request).pipe(
              Effect.timeoutOrElse({
                duration: timeout,
                orElse: () =>
                  Effect.fail(
                    transport(`Runner request timed out after ${Duration.format(timeout)}`),
                  ),
              }),
              Effect.mapError((error) =>
                error._tag === "RunnerClientError"
                  ? error
                  : transport(`Runner unreachable: ${error.message}`),
              ),
            )
            const text = yield* response.text.pipe(
              Effect.mapError((cause) =>
                transport(`Could not read runner response: ${cause.message}`),
              ),
            )
            const json = yield* decodeJson(text).pipe(
              Effect.mapError(() =>
                transport(`Runner responded ${response.status} without JSON`, response.status),
              ),
            )
            if (response.status >= 200 && response.status < 300)
              return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
                Effect.mapError((cause) =>
                  transport(`Runner response did not decode: ${cause.message}`),
                ),
              )
            const decoded = decodeError(json)
            if (decoded._tag === "None")
              return yield* transport(`Runner responded ${response.status}`, response.status)
            return yield* new RunnerClientError({
              code: decoded.value.code,
              message: decoded.value.message,
              reason: decoded.value.reason,
              status: response.status,
            })
          })

        const sessionPath = (sessionId: AgentSessionId) =>
          `/v1/sessions/${encodeURIComponent(sessionId)}`

        return {
          createSession: (sessionId, request) =>
            send("PUT", sessionPath(sessionId), request, CreateSessionResult),
          admitInput: (sessionId, request) =>
            send("POST", `${sessionPath(sessionId)}/inputs`, request, AdmitResult),
          inspect: (sessionId) => send("GET", sessionPath(sessionId), undefined, Inspection),
          readEvents: (sessionId, after, limit = EVENT_PAGE_LIMIT) =>
            send(
              "GET",
              `${sessionPath(sessionId)}/events?after=${after}&limit=${limit}`,
              undefined,
              EventsRead,
            ),
          maintenance: (sessionId, request) =>
            send("POST", `${sessionPath(sessionId)}/maintenance`, request, MaintenanceResult),
          cleanup: (sessionId, generation) =>
            send("DELETE", sessionPath(sessionId), { generation }, CleanupResult),
        }
      }),
    )
}
