// A `fetch` that records every model request and streamed response to disk,
// so reasoning round-trips can be checked in the requests themselves. The
// Authorization header (and anything that looks like a credential) is
// replaced before anything is written.

import * as fs from "node:fs"
import * as path from "node:path"

export interface CaptureRecord {
  readonly n: number
  readonly url: string
  readonly status: number
  readonly startedAt: number
  readonly headersAt: number
  readonly endedAt: number
  readonly requestBytes: number
  readonly responseBytes: number
}

const SENSITIVE = /authorization|api-key|apikey|token|secret|cookie/i

const redactHeaders = (headers: Headers): Record<string, string> => {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key] = SENSITIVE.test(key) ? "<redacted>" : value
  })
  return out
}

const bodyToText = (body: BodyInit | null | undefined): string => {
  if (body === undefined || body === null) return ""
  if (typeof body === "string") return body
  if (body instanceof Uint8Array) return new TextDecoder().decode(body)
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body))
  return `<unsupported body: ${Object.prototype.toString.call(body)}>`
}

const tryJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export const makeCapturingFetch = (
  dir: string,
  shouldCapture: (url: string) => boolean,
  onRecord: (record: CaptureRecord) => void,
): typeof globalThis.fetch => {
  fs.mkdirSync(dir, { recursive: true })
  const realFetch = globalThis.fetch
  let counter = 0
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    if (!shouldCapture(url)) return realFetch(input, init)
    const n = ++counter
    const id = String(n).padStart(3, "0")
    const method = init?.method ?? request?.method ?? "GET"
    const headers = redactHeaders(new Headers(init?.headers ?? request?.headers))
    const requestText = bodyToText(init?.body as BodyInit | null | undefined)
    const startedAt = Date.now()
    fs.writeFileSync(
      path.join(dir, `${id}-request.json`),
      JSON.stringify({ n, url, method, headers, body: tryJson(requestText) }, null, 2),
    )
    const response = await realFetch(input, init)
    const headersAt = Date.now()
    const responseHeaders = redactHeaders(response.headers)
    if (response.body === null) {
      const endedAt = Date.now()
      fs.writeFileSync(path.join(dir, `${id}-response.txt`), "")
      const record: CaptureRecord = {
        n,
        url,
        status: response.status,
        startedAt,
        headersAt,
        endedAt,
        requestBytes: requestText.length,
        responseBytes: 0,
      }
      fs.writeFileSync(
        path.join(dir, `${id}-meta.json`),
        JSON.stringify({ ...record, responseHeaders }, null, 2),
      )
      onRecord(record)
      return response
    }
    const [forClient, forFile] = response.body.tee()
    void (async () => {
      const reader = forFile.getReader()
      const decoder = new TextDecoder()
      let text = ""
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          text += decoder.decode(value, { stream: true })
        }
      } catch (error) {
        text += `\n<capture aborted: ${String(error)}>`
      }
      const endedAt = Date.now()
      fs.writeFileSync(path.join(dir, `${id}-response.txt`), text)
      const record: CaptureRecord = {
        n,
        url,
        status: response.status,
        startedAt,
        headersAt,
        endedAt,
        requestBytes: requestText.length,
        responseBytes: text.length,
      }
      fs.writeFileSync(
        path.join(dir, `${id}-meta.json`),
        JSON.stringify({ ...record, responseHeaders }, null, 2),
      )
      onRecord(record)
    })()
    return new Response(forClient, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}
