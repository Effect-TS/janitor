// Parses the versioned HTTP command boundary into runner commands.
import { Schema } from "effect"
import {
  AdmitInput,
  Cleanup,
  CreateSession,
  Maintenance,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  ProtocolError,
  SessionId,
} from "./Protocol.ts"

export type Command =
  | { readonly kind: "create"; readonly sessionId: SessionId; readonly body: CreateSession }
  | { readonly kind: "admit"; readonly sessionId: SessionId; readonly body: AdmitInput }
  | { readonly kind: "inspect"; readonly sessionId: SessionId }
  | {
      readonly kind: "events"
      readonly sessionId: SessionId
      readonly after: number
      readonly limit: number
    }
  | { readonly kind: "maintenance"; readonly sessionId: SessionId; readonly body: Maintenance }
  | { readonly kind: "cleanup"; readonly sessionId: SessionId; readonly body: Cleanup }

const decodeSessionId = Schema.decodeUnknownSync(SessionId)
const decoders = {
  create: Schema.decodeUnknownSync(CreateSession),
  admit: Schema.decodeUnknownSync(AdmitInput),
  maintenance: Schema.decodeUnknownSync(Maintenance),
  cleanup: Schema.decodeUnknownSync(Cleanup),
}

export const EVENT_READ_LIMIT = 500

export const checkProtocol = (request: Request) => {
  const header = request.headers.get(PROTOCOL_HEADER)
  if (header === null || Number(header) !== PROTOCOL_VERSION)
    throw new ProtocolError(
      "incompatible_protocol",
      `This runner speaks protocol ${PROTOCOL_VERSION}; the request declared ${header ?? "none"}`,
    )
}

/** The session addressed by a request path, or null for non-session routes. */
export const sessionIdOf = (url: URL): SessionId | null => {
  const match = /^\/v1\/sessions\/([^/]+)(?:\/.*)?$/.exec(url.pathname)
  if (match === null) return null
  try {
    return decodeSessionId(decodeURIComponent(match[1]!))
  } catch {
    throw new ProtocolError("invalid_request", "Malformed session identifier")
  }
}

const json = async <K extends keyof typeof decoders>(request: Request, kind: K) => {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    throw new ProtocolError("invalid_request", "Request body is not JSON")
  }
  try {
    return decoders[kind](raw) as ReturnType<(typeof decoders)[K]>
  } catch (cause) {
    throw new ProtocolError("invalid_request", `Invalid ${kind} request: ${describe(cause)}`)
  }
}

export const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

export const parseCommand = async (request: Request): Promise<Command> => {
  checkProtocol(request)
  const url = new URL(request.url)
  const sessionId = sessionIdOf(url)
  if (sessionId === null)
    throw new ProtocolError("invalid_request", `Unknown route ${url.pathname}`)
  const rest = /^\/v1\/sessions\/[^/]+(\/.*)?$/.exec(url.pathname)?.[1] ?? ""
  const method = request.method.toUpperCase()
  if (rest === "" || rest === "/") {
    if (method === "PUT") return { kind: "create", sessionId, body: await json(request, "create") }
    if (method === "GET") return { kind: "inspect", sessionId }
    if (method === "DELETE")
      return { kind: "cleanup", sessionId, body: await json(request, "cleanup") }
  }
  if (rest === "/inputs" && method === "POST")
    return { kind: "admit", sessionId, body: await json(request, "admit") }
  if (rest === "/events" && method === "GET") {
    const after = Number(url.searchParams.get("after") ?? "0")
    const limit = Number(url.searchParams.get("limit") ?? String(EVENT_READ_LIMIT))
    if (!Number.isInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1)
      throw new ProtocolError("invalid_request", "Event cursors are non-negative integers")
    return { kind: "events", sessionId, after, limit: Math.min(limit, EVENT_READ_LIMIT) }
  }
  if (rest === "/maintenance" && method === "POST")
    return { kind: "maintenance", sessionId, body: await json(request, "maintenance") }
  throw new ProtocolError("invalid_request", `Unknown route ${method} ${url.pathname}`)
}

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) },
  })

export const errorResponse = (error: unknown) => {
  if (error instanceof ProtocolError) return jsonResponse(error.body, error.status)
  return jsonResponse({ code: "transport", message: describe(error) }, 503)
}
