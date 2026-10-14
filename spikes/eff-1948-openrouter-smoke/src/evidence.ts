// Reads a run's captured HTTP traffic and answers, from the requests
// themselves, whether reasoning state round-tripped between tool-call turns:
// for every response that carried reasoning (`reasoning_details` on
// OpenRouter, encrypted reasoning items on the OpenAI Responses API), did the
// following request send it back?
//
//   node src/evidence.ts results/openrouter/run-1-pr9161 [...more run dirs]

import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

interface Detail {
  readonly type: string
  readonly id?: string
  readonly format?: string
  readonly bytes: number
  /** sha256 of the encrypted payload, to check it is sent back unchanged */
  readonly sha?: string
}

export interface UsageSummary {
  readonly promptTokens: number
  readonly completionTokens: number
  readonly reasoningTokens: number
  readonly cachedTokens: number
  readonly costUsd: number | undefined
}

interface ResponseReasoning {
  readonly details: Array<Detail>
  readonly reasoningChars: number
  readonly toolCalls: number
  readonly finishReason: string | undefined
  readonly usage: UsageSummary | undefined
}

const openRouterUsage = (u: any): UsageSummary | undefined =>
  u === undefined
    ? undefined
    : {
        promptTokens: u.prompt_tokens ?? 0,
        completionTokens: u.completion_tokens ?? 0,
        reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
        cachedTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
        costUsd: typeof u.cost === "number" ? u.cost : undefined,
      }

const openAiUsage = (u: any): UsageSummary | undefined =>
  u === undefined
    ? undefined
    : {
        promptTokens: u.input_tokens ?? 0,
        completionTokens: u.output_tokens ?? 0,
        reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? 0,
        cachedTokens: u.input_tokens_details?.cached_tokens ?? 0,
        costUsd: undefined,
      }

interface RequestReasoning {
  readonly messages: number
  readonly assistantMessages: number
  readonly assistantWithToolCalls: number
  readonly assistantWithDetails: number
  readonly details: Array<Detail>
  readonly reasoningConfig: unknown
  readonly model: unknown
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16)

const summarizeDetail = (d: Record<string, unknown>): Detail => ({
  type: String(d.type),
  id: typeof d.id === "string" ? d.id : undefined,
  format: typeof d.format === "string" ? d.format : undefined,
  sha: typeof d.data === "string" ? sha256(d.data) : undefined,
  bytes:
    typeof d.data === "string"
      ? d.data.length
      : typeof d.text === "string"
        ? d.text.length
        : typeof d.summary === "string"
          ? d.summary.length
          : 0,
})

// OpenRouter chat completions: SSE `data:` lines with chat.completion.chunk.
const readOpenRouterResponse = (text: string): ResponseReasoning => {
  const details: Array<Detail> = []
  let reasoningChars = 0
  const toolCallIds = new Set<string>()
  let finishReason: string | undefined
  let usage: UsageSummary | undefined
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const payload = line.slice(6).trim()
    if (payload === "[DONE]") continue
    let chunk: any
    try {
      chunk = JSON.parse(payload)
    } catch {
      continue
    }
    if (chunk.usage) usage = openRouterUsage(chunk.usage)
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta ?? {}
      if (typeof delta.reasoning === "string") reasoningChars += delta.reasoning.length
      for (const d of delta.reasoning_details ?? []) details.push(summarizeDetail(d))
      for (const call of delta.tool_calls ?? []) {
        if (typeof call.id === "string") toolCallIds.add(call.id)
      }
      if (choice.finish_reason) finishReason = choice.finish_reason
    }
  }
  return { details, reasoningChars, toolCalls: toolCallIds.size, finishReason, usage }
}

const readOpenRouterRequest = (body: any): RequestReasoning => {
  const messages: Array<any> = body.messages ?? []
  const assistant = messages.filter((m) => m.role === "assistant")
  const details: Array<Detail> = []
  let assistantWithDetails = 0
  for (const m of assistant) {
    if (Array.isArray(m.reasoning_details) && m.reasoning_details.length > 0) {
      assistantWithDetails++
      for (const d of m.reasoning_details) details.push(summarizeDetail(d))
    }
  }
  return {
    messages: messages.length,
    assistantMessages: assistant.length,
    assistantWithToolCalls: assistant.filter((m) => Array.isArray(m.tool_calls) && m.tool_calls.length > 0).length,
    assistantWithDetails,
    details,
    reasoningConfig: body.reasoning ?? body.reasoning_effort,
    model: body.model,
  }
}

// OpenAI Responses API: SSE events; reasoning items with encrypted_content.
const readOpenAiResponse = (text: string): ResponseReasoning => {
  const details: Array<Detail> = []
  let reasoningChars = 0
  let toolCalls = 0
  let usage: UsageSummary | undefined
  let finishReason: string | undefined
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue
    let event: any
    try {
      event = JSON.parse(line.slice(6))
    } catch {
      continue
    }
    if (event.type === "response.output_item.done" && event.item?.type === "reasoning") {
      details.push({
        type: "reasoning",
        id: event.item.id,
        format: "openai-encrypted",
        sha: typeof event.item.encrypted_content === "string" ? sha256(event.item.encrypted_content) : undefined,
        bytes: typeof event.item.encrypted_content === "string" ? event.item.encrypted_content.length : 0,
      })
    }
    if (event.type === "response.reasoning_summary_text.delta") reasoningChars += String(event.delta ?? "").length
    if (event.type === "response.output_item.done" && event.item?.type === "function_call") toolCalls++
    if (event.type === "response.completed") {
      usage = openAiUsage(event.response?.usage)
      finishReason = event.response?.status
    }
  }
  return { details, reasoningChars, toolCalls, finishReason, usage }
}

const readOpenAiRequest = (body: any): RequestReasoning => {
  const input: Array<any> = Array.isArray(body.input) ? body.input : []
  const reasoningItems = input.filter((i) => i.type === "reasoning")
  const details = reasoningItems.map((i) => ({
    type: "reasoning",
    id: i.id,
    format: "openai-encrypted",
    sha: typeof i.encrypted_content === "string" ? sha256(i.encrypted_content) : undefined,
    bytes: typeof i.encrypted_content === "string" ? i.encrypted_content.length : 0,
  }))
  return {
    messages: input.length,
    assistantMessages: input.filter((i) => i.role === "assistant" || i.type === "function_call").length,
    assistantWithToolCalls: input.filter((i) => i.type === "function_call").length,
    assistantWithDetails: reasoningItems.length,
    details,
    reasoningConfig: body.reasoning,
    model: body.model,
  }
}

export interface TurnEvidence {
  readonly request: number
  readonly requestSummary: RequestReasoning
  readonly response: ResponseReasoning
  /** ids of the reasoning details this response produced */
  readonly producedIds: Array<string>
  /** of the ids produced by earlier responses, how many the request carried */
  readonly carriedFromEarlier: { expected: number; carried: number; missing: Array<string>; altered: Array<string> }
}

export const analyseRun = (dir: string) => {
  const httpDir = path.join(dir, "http")
  const files = fs.readdirSync(httpDir).filter((f) => f.endsWith("-request.json")).sort()
  const isOpenAi = (url: string) => url.includes("api.openai.com") || url.includes("/responses")
  const turns: Array<TurnEvidence> = []
  const producedSoFar: Array<string> = []
  const producedSha = new Map<string, string>()
  for (const file of files) {
    const n = Number(file.slice(0, 3))
    const request = JSON.parse(fs.readFileSync(path.join(httpDir, file), "utf8"))
    const responseFile = path.join(httpDir, `${file.slice(0, 3)}-response.txt`)
    const responseText = fs.existsSync(responseFile) ? fs.readFileSync(responseFile, "utf8") : ""
    const openai = isOpenAi(request.url)
    const requestSummary = openai ? readOpenAiRequest(request.body) : readOpenRouterRequest(request.body)
    const response = openai ? readOpenAiResponse(responseText) : readOpenRouterResponse(responseText)
    const carried = new Map<string, string | undefined>()
    for (const d of requestSummary.details) if (d.id !== undefined) carried.set(d.id, d.sha)
    const missing = producedSoFar.filter((id) => !carried.has(id))
    const altered = producedSoFar.filter(
      (id) => carried.has(id) && producedSha.get(id) !== undefined && carried.get(id) !== producedSha.get(id),
    )
    const producedIds = [...new Set(response.details.map((d) => d.id).filter((id): id is string => id !== undefined))]
    for (const d of response.details) if (d.id !== undefined && d.sha !== undefined) producedSha.set(d.id, d.sha)
    turns.push({
      request: n,
      requestSummary,
      response,
      producedIds,
      carriedFromEarlier: {
        expected: producedSoFar.length,
        carried: producedSoFar.length - missing.length,
        missing,
        altered,
      },
    })
    producedSoFar.push(...producedIds)
  }
  return turns
}

export const renderRun = (dir: string, turns: Array<TurnEvidence>): string => {
  const lines = [
    `### ${path.basename(path.dirname(dir))}/${path.basename(dir)}`,
    "",
    "| req | msgs | asst w/ tool_calls | asst w/ reasoning_details | encrypted blobs carried (expected) | missing | altered | resp reasoning_details | resp types | reasoning tokens | prompt / cached | completion | cost USD | finish |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ]
  let cost = 0
  let prompt = 0
  let completion = 0
  let reasoning = 0
  for (const t of turns) {
    const types = [...new Set(t.response.details.map((d) => `${d.type}${d.format ? `/${d.format}` : ""}`))].join(" ")
    const u = t.response.usage
    cost += u?.costUsd ?? 0
    prompt += u?.promptTokens ?? 0
    completion += u?.completionTokens ?? 0
    reasoning += u?.reasoningTokens ?? 0
    lines.push(
      `| ${t.request} | ${t.requestSummary.messages} | ${t.requestSummary.assistantWithToolCalls} | ${t.requestSummary.assistantWithDetails} | ${t.carriedFromEarlier.carried} (${t.carriedFromEarlier.expected}) | ${t.carriedFromEarlier.missing.length} | ${t.carriedFromEarlier.altered.length} | ${t.response.details.length} (${t.producedIds.length} ids) | ${types} | ${u?.reasoningTokens ?? ""} | ${u?.promptTokens ?? ""} / ${u?.cachedTokens ?? ""} | ${u?.completionTokens ?? ""} | ${u?.costUsd === undefined ? "" : u.costUsd.toFixed(4)} | ${t.response.finishReason ?? ""} |`,
    )
  }
  lines.push("")
  lines.push(
    `Model \`${turns[0]?.requestSummary.model}\`, reasoning ${JSON.stringify(turns[0]?.requestSummary.reasoningConfig)}. Totals: ${turns.length} requests, ${prompt} prompt tokens, ${completion} completion tokens (${reasoning} reasoning), provider-reported cost $${cost.toFixed(4)}.`,
  )
  lines.push("")
  return lines.join("\n")
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const dirs = process.argv.slice(2)
  for (const dir of dirs) {
    const turns = analyseRun(dir)
    fs.writeFileSync(path.join(dir, "evidence.json"), JSON.stringify(turns, null, 2))
    const md = renderRun(dir, turns)
    fs.writeFileSync(path.join(dir, "evidence.md"), md)
    console.log(md)
  }
}
