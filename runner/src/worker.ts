// The runner Worker entry: authenticates the service caller, checks the
// protocol version and routes each session command to that session's
// Durable Object. Everything stateful lives in `SessionRunner`.
import { PROTOCOL_VERSION, ProtocolError } from "./Protocol.ts"
import { checkProtocol, errorResponse, jsonResponse, sessionIdOf } from "./Router.ts"
import { SessionRunner, type RunnerEnv } from "./SessionRunner.ts"

export { SessionRunner }

export interface WorkerEnv extends RunnerEnv {
  readonly SESSIONS: DurableObjectNamespace<SessionRunner>
}

const constantTimeEqual = (a: string, b: string) => {
  const encoder = new TextEncoder()
  const left = encoder.encode(a)
  const right = encoder.encode(b)
  let difference = left.byteLength ^ right.byteLength
  for (let index = 0; index < Math.max(left.byteLength, right.byteLength); index++)
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  return difference === 0
}

export const authenticate = (request: Request, env: RunnerEnv) => {
  const expected = env.JANITOR_AGENT_RUNNER_TOKEN
  const header = request.headers.get("authorization") ?? ""
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : ""
  if (
    typeof expected !== "string" ||
    expected === "" ||
    presented === "" ||
    !constantTimeEqual(expected, presented)
  )
    throw new ProtocolError("unauthorized", "A valid runner service token is required")
}

export const handle = async (request: Request, env: WorkerEnv): Promise<Response> => {
  try {
    authenticate(request, env)
    const url = new URL(request.url)
    if (url.pathname === "/v1/health" && request.method === "GET")
      return jsonResponse({
        protocol: PROTOCOL_VERSION,
        release: env.JANITOR_AGENT_RUNNER_RELEASE ?? "development",
      })
    checkProtocol(request)
    const sessionId = sessionIdOf(url)
    if (sessionId === null)
      throw new ProtocolError("invalid_request", `Unknown route ${url.pathname}`)
    return env.SESSIONS.get(env.SESSIONS.idFromName(sessionId)).fetch(request)
  } catch (error) {
    return errorResponse(error)
  }
}

export default {
  fetch: handle,
} satisfies ExportedHandler<WorkerEnv>
