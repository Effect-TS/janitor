// Runs the test bundle in Miniflare and speaks the runner protocol to it.
import { Miniflare } from "miniflare"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from "../../src/Protocol.ts"
import type { ModelScript, TestFaults } from "../worker.ts"

export const TOKEN = "runner-test-token"
export const SECRET_BINDING = "MODEL_SECRET_TEST"

export const testConfigurations = {
  default: "test-default",
  records: [
    {
      id: "test-default",
      provider: "scripted",
      apiModelId: "scripted-1",
      route: "openai-chat",
      endpoint: "https://provider.test/v1/",
      secretBinding: SECRET_BINDING,
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      limit: { context: 100000, output: 4000 },
    },
    {
      id: "test-alternate",
      provider: "scripted",
      apiModelId: "scripted-2",
      route: "openai-chat",
      endpoint: "https://provider.test/v1/",
      secretBinding: SECRET_BINDING,
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      limit: { context: 50000, output: 2000 },
    },
  ],
}

export interface HarnessOptions {
  readonly serviceBindings?: Record<string, (request: Request) => Promise<Response>>
  readonly persist?: string
  readonly secret?: string | undefined
  readonly bindings?: Record<string, string>
}

export const scriptPath = () => new URL("../../dist-test/worker.mjs", import.meta.url).pathname

export const makeMiniflare = (options: HarnessOptions = {}) =>
  new Miniflare({
    modules: true,
    scriptPath: scriptPath(),
    // Janitor's pinned local workerd is 1.20260704.1; keep the same local date.
    compatibilityDate: "2026-07-04",
    compatibilityFlags: ["nodejs_compat"],
    bindings: {
      JANITOR_AGENT_RUNNER_TOKEN: TOKEN,
      JANITOR_AGENT_RUNNER_RELEASE: "test",
      JANITOR_AGENT_RUNNER_MODEL_CONFIGURATIONS: JSON.stringify(testConfigurations),
      ...(options.secret === undefined ? {} : { [SECRET_BINDING]: options.secret }),
      ...options.bindings,
    },
    durableObjects: { SESSIONS: { className: "SessionRunner", useSQLite: true } },
    serviceBindings: options.serviceBindings,
    ...(options.persist === undefined ? {} : { durableObjectsPersist: options.persist }),
  })

export interface Call {
  readonly status: number
  readonly body: any
}

export class Harness {
  private constructor(
    public mf: Miniflare,
    readonly persist: string,
    private readonly options: HarnessOptions,
  ) {}

  static async start(options: HarnessOptions = {}) {
    const persist = options.persist ?? fs.mkdtempSync(path.join(os.tmpdir(), "janitor-runner-"))
    const mf = makeMiniflare({ ...options, persist })
    await mf.ready
    return new Harness(mf, persist, { ...options, persist })
  }

  /** Simulates process replacement: the same durable storage, a fresh runtime. */
  async restart() {
    await this.mf.dispose()
    this.mf = makeMiniflare(this.options)
    await this.mf.ready
  }

  async dispose() {
    await this.mf.dispose()
    fs.rmSync(this.persist, { recursive: true, force: true })
  }

  async raw(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Call> {
    const response = await this.mf.dispatchFetch("http://runner.test" + path, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    let parsed: unknown = text
    try {
      parsed = JSON.parse(text)
    } catch {
      // Non-JSON bodies are surfaced as text.
    }
    return { status: response.status, body: parsed }
  }

  async call(method: string, path: string, body?: unknown, expected = 200): Promise<any> {
    const result = await this.raw(method, path, body)
    if (result.status !== expected)
      throw new Error(`${method} ${path} returned ${result.status}: ${JSON.stringify(result.body)}`)
    return result.body
  }

  session(id: string) {
    return new SessionDriver(this, id)
  }
}

export class SessionDriver {
  constructor(
    readonly harness: Harness,
    readonly id: string,
  ) {}
  private get base() {
    return `/v1/sessions/${this.id}`
  }
  model(script: ModelScript) {
    return this.harness.call("POST", `/__test/sessions/${this.id}/model`, script)
  }
  faults(faults: Partial<TestFaults>) {
    return this.harness.call("POST", `/__test/sessions/${this.id}/faults`, faults)
  }
  state() {
    return this.harness.call("GET", `/__test/sessions/${this.id}/state`)
  }
  create(
    body: {
      generation?: number
      title?: string
      modelConfigurationId?: string
      repositoryId?: string
    } = {},
    expected = 200,
  ) {
    return this.harness.call(
      "PUT",
      this.base,
      {
        generation: body.generation ?? 1,
        title: body.title ?? "test session",
        ...(body.modelConfigurationId ? { modelConfigurationId: body.modelConfigurationId } : {}),
        ...(body.repositoryId ? { repositoryId: body.repositoryId } : {}),
      },
      expected,
    )
  }
  admit(
    input: {
      inputId: string
      text: string
      generation?: number
      attribution?: Record<string, unknown>
    },
    expected = 200,
  ) {
    return this.harness.call(
      "POST",
      `${this.base}/inputs`,
      {
        generation: input.generation ?? 1,
        inputId: input.inputId,
        text: input.text,
        attribution: input.attribution ?? {
          source: "driver",
          teammateId: "tm_1",
          displayName: "Driver",
        },
      },
      expected,
    )
  }
  inspect(expected = 200) {
    return this.harness.call("GET", this.base, undefined, expected)
  }
  events(after = 0, limit = 500, expected = 200) {
    return this.harness.call(
      "GET",
      `${this.base}/events?after=${after}&limit=${limit}`,
      undefined,
      expected,
    )
  }
  maintenance(body: { hold: boolean; epoch: number }, expected = 200) {
    return this.harness.call("POST", `${this.base}/maintenance`, body, expected)
  }
  cleanup(generation = 1, expected = 200) {
    return this.harness.call("DELETE", this.base, { generation }, expected)
  }

  /** Reads all durable events after `after` in pages, as a consumer would. */
  async allEvents(after = 0) {
    const events: any[] = []
    let cursor = after
    for (;;) {
      const page = await this.events(cursor, 100)
      events.push(...page.events)
      if (page.events.length === 0)
        return { events, usage: page.usage, synced: page.synced, next: cursor }
      cursor = page.next
    }
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Polls until `predicate` holds or the deadline passes; returns the last observed value. */
export const waitFor = async <T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> => {
  const deadline = Date.now() + (options.timeoutMs ?? 20_000)
  let last = await read()
  while (!predicate(last)) {
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${options.label ?? "condition"}`)
    await sleep(options.intervalMs ?? 200)
    last = await read()
  }
  return last
}

export const uniqueSessionId = (prefix: string) =>
  `${prefix}-${Math.random().toString(36).slice(2, 10)}`
