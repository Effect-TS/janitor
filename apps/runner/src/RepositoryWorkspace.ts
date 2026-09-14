import { Effect } from "effect"
import { WorkspaceDriver } from "@opencode/core/workspace/driver"
import { getSandbox, type Sandbox } from "@cloudflare/sandbox"
import { makeRemoteSpawner, type BridgeRpc } from "./RemoteProcess.ts"
import { ProtocolError } from "./Protocol.ts"
import { RELEASE_MANIFEST } from "./ReleaseManifest.ts"
import { RunnerStorage } from "./Storage.ts"
import { WorkspaceCheckpoints, type Archive } from "./WorkspaceCheckpoints.ts"
import { Publication, type CredentialPermission, type RepositoryCredential } from "./Publication.ts"

/** The native shell's default command deadline; explicit finite timeouts may exceed it. */
export const DEFAULT_TOOL_TIMEOUT_MS = 120000

// Only forward fixed bridge diagnostics. Arbitrary response bodies can contain
// repository data or credentials, including responses from the Sandbox transport.
const bridgeDiagnostics = new Set([
  "stale generation",
  "stale epoch; reconcile before retry",
  "clone outcome requires reconciliation",
  "repository destination exists",
  "repository clone failed",
  "preparation outcome requires reconciliation",
  "publication active",
  "processes active",
])
export const REPOSITORY_TOOLS: ReadonlyArray<string> = [
  "read",
  "glob",
  "grep",
  "edit",
  "write",
  "shell",
  "publish",
]
const payloadHash = async (value: unknown) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  )
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export interface RepositorySelection {
  readonly sessionId: string
  readonly generation: number
  readonly repositoryId: string
}
// 220 hash bits plus the prefix fit the Sandbox SDK's 63-character ID limit.
const resourceName = async (selected: RepositorySelection) =>
  `janitor-${(await payloadHash(selected)).slice(0, 55)}`
export interface RepositoryAuthority {
  readonly fetch: (request: Request) => Promise<Response>
}
export interface WorkspaceEnvironment {
  readonly WORKSPACE_CHECKPOINTS?: R2Bucket
  readonly SANDBOXES?: DurableObjectNamespace<Sandbox>
  readonly REPOSITORY_AUTHORITY?: RepositoryAuthority
  readonly REPOSITORY_SERVICE_TOKEN?: string
  readonly GITHUB_PUBLICATION_API?: RepositoryAuthority
}
export interface Binding {
  resource: string
  token: string
  epoch?: string
  selected: RepositorySelection
  destroyed?: boolean
}
export interface WorkspaceSandbox {
  getProcess?(
    id: string,
  ): Promise<{ waitForPort(port: number, options: { mode: "tcp" }): Promise<unknown> } | null>
  startProcess(
    command: string,
    options: { processId: string; env: Record<string, string> },
  ): Promise<{ waitForPort(port: number, options: { mode: "tcp" }): Promise<unknown> }>
  containerFetch(url: string, init: RequestInit, port: number): Promise<Response>
  destroy(): Promise<unknown>
}
export interface Meta {
  protocol: number
  generation: number
  epoch: string
  capabilities: string[]
  /** Source identity recorded at image build; absent on images built before the manifest. */
  build?: { sourceHash?: string } | null
}
/**
 * The running bridge must be the one this release was tested against: same
 * protocol, every required capability and the pinned source identity. A
 * deployment result says an image rollout started; only the reached container
 * proves which image answered.
 */
export const checkBridge = (meta: Meta, generation: number) => {
  const required = RELEASE_MANIFEST.bridge
  if (
    meta.protocol !== required.protocol ||
    !required.required.every((capability) => meta.capabilities?.includes(capability))
  )
    throw new ProtocolError("blocked", "Running Sandbox image lacks required bridge capabilities")
  if (meta.build?.sourceHash !== required.sourceHash)
    throw new ProtocolError(
      "blocked",
      `Running Sandbox image ${meta.build?.sourceHash?.slice(0, 12) ?? "(unrecorded)"} is not the release's bridge ${required.sourceHash.slice(0, 12)}`,
    )
  if (meta.generation !== generation)
    throw new ProtocolError("stale_generation", "Bridge generation changed")
}

/** Runner-owned provisioning identity and admission evidence survive container loss. */
export class RepositoryWorkspace {
  readonly checkpoints: WorkspaceCheckpoints
  readonly publication: Publication
  private toolTimeout = DEFAULT_TOOL_TIMEOUT_MS
  private activeTool: string | undefined
  private connecting: Promise<Binding> | undefined
  private readonly inFlight = new Set<string>()
  private publishing = 0
  /**
   * A foreground operation, publication or archive upload is in progress.
   * Maintenance waits for this to clear so the result and checkpoint commit
   * together instead of leaving an admitted operation uncertain.
   */
  get busy(): boolean {
    return (
      this.activeTool !== undefined ||
      this.inFlight.size > 0 ||
      this.publishing > 0 ||
      this.checkpoints.settling
    )
  }
  /** True when a workspace operation's outcome is unknown and must be reconciled. */
  get uncertain(): boolean {
    return (
      this.checkpoints.uncertain() ||
      this.storage.sql
        .exec("SELECT id FROM _janitor_operation WHERE state = 'admitted' LIMIT 1")
        .toArray().length > 0
    )
  }
  /** The finite timeout of the admitted foreground tool, if one is active. */
  get currentToolTimeout(): number | undefined {
    return this.activeTool === undefined ? undefined : this.toolTimeout
  }
  /**
   * The advertised identity of the bridge process, when one is running for this
   * workspace, without starting a container or restoring anything.
   */
  async runningBridge(): Promise<Meta | undefined> {
    const binding = await this.storage.get<Binding>("_janitor_workspace")
    if (!binding?.epoch || binding.destroyed) return undefined
    const sandbox = this.sandbox(binding)
    const process = await sandbox.getProcess?.("janitor-bridge")
    if (!process) return undefined
    return (await this.raw(binding, "/meta")) as Meta
  }
  /** Runs a publication while counting it as active work. */
  async publish<A>(run: () => Promise<A>): Promise<A> {
    this.publishing++
    try {
      return await run()
    } finally {
      this.publishing--
    }
  }
  private hold(message: string): never {
    const store = new RunnerStorage(this.storage)
    store.blockers = [...new Set([...store.blockers, message])]
    throw new ProtocolError("blocked", message)
  }
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly env: WorkspaceEnvironment,
    readonly selected: RepositorySelection,
  ) {
    this.checkpoints = new WorkspaceCheckpoints(storage, env.WORKSPACE_CHECKPOINTS, selected)
    this.publication = new Publication(storage, selected, {
      authorize: (token, permission, refresh) => this.authority(token, permission, refresh, true),
      fetch: (request) => env.GITHUB_PUBLICATION_API?.fetch(request) ?? fetch(request),
      fence: async () => {
        if (
          new RunnerStorage(storage).disconnection !== undefined ||
          (await storage.get<Binding>("_janitor_workspace"))?.destroyed
        )
          throw new ProtocolError("stale_generation", "Late publication completion fenced")
      },
      git: async <A>(action: string, input: unknown): Promise<A> => {
        const binding = await storage.get<Binding>("_janitor_workspace")
        if (!binding?.epoch) throw new ProtocolError("blocked", "Workspace is unavailable")
        const meta = (await this.raw(binding, "/meta")) as Meta
        checkBridge(meta, selected.generation)
        if (meta.epoch !== binding.epoch)
          throw new ProtocolError("blocked", "Bridge changed during publication")
        // Credentials never enter the ordinary process operation journal.
        return (await this.raw(binding, `/git/${action}`, input)) as A
      },
      checkpoint: async () => {
        const binding = await storage.get<Binding>("_janitor_workspace")
        if (!binding?.epoch) throw new ProtocolError("blocked", "Workspace is unavailable")
        await this.checkpoints.commit(await this.snapshot(binding), binding.resource)
      },
    })
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS _janitor_operation (
      id TEXT PRIMARY KEY, epoch TEXT NOT NULL, payload_hash TEXT NOT NULL,
      payload TEXT NOT NULL, state TEXT NOT NULL, result TEXT)`)
  }
  private async authority(
    token: boolean,
    permission: CredentialPermission = "read",
    refresh = false,
    publication = false,
  ) {
    if (!this.env.REPOSITORY_AUTHORITY || !this.env.REPOSITORY_SERVICE_TOKEN)
      throw new ProtocolError("blocked", "Repository credential authority is not configured")
    const response = await this.env.REPOSITORY_AUTHORITY.fetch(
      new Request("https://janitor/api/v1/agent/repository", {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.env.REPOSITORY_SERVICE_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ...this.selected, token, permission, refresh, publication }),
        signal: AbortSignal.timeout(20000),
      }),
    )
    if (!response.ok) {
      // Janitor names the fence (paused, access lost, synchronizing, ended). The
      // reason reaches the agent's tool result and the dashboard through the
      // blocked error; a body-less refusal keeps the generic explanation.
      let reason = "Selected repository is not ready or credentials are unavailable"
      try {
        const body = (await response.json()) as { message?: unknown }
        if (typeof body.message === "string" && body.message !== "") reason = body.message
      } catch {
        // No JSON body: the generic reason stands.
      }
      throw new ProtocolError("blocked", reason, reason)
    }
    return response.json() as Promise<RepositoryCredential>
  }
  protected sandbox(binding: Binding): WorkspaceSandbox {
    if (!this.env.SANDBOXES)
      throw new ProtocolError("blocked", "Sandbox namespace is not configured")
    return getSandbox(this.env.SANDBOXES, binding.resource)
  }
  private async request(binding: Binding, path: string, input?: unknown, archive?: Archive) {
    const current = await this.storage.get<Binding>("_janitor_workspace")
    if (
      current?.destroyed ||
      (path.startsWith("/git/") && new RunnerStorage(this.storage).disconnection !== undefined)
    )
      throw new ProtocolError("stale_generation", "Workspace was destroyed")
    const response = await this.sandbox(binding).containerFetch(
      `http://bridge${path}`,
      {
        method: input === undefined && !archive ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${binding.token}`,
          "x-janitor-generation": String(this.selected.generation),
          "x-bridge-epoch": binding.epoch ?? "",
          "content-type": "application/json",
          ...(archive
            ? {
                "content-type": "application/x-ndjson",
                "content-length": String(archive.size),
                "x-archive-sha256": archive.sha256,
              }
            : {}),
        },
        body: archive?.body ?? (input === undefined ? undefined : JSON.stringify(input)),
      },
      8788,
    )
    if (
      (await this.storage.get<Binding>("_janitor_workspace"))?.destroyed ||
      (path.startsWith("/git/") && new RunnerStorage(this.storage).disconnection !== undefined)
    )
      throw new ProtocolError("stale_generation", "Late workspace response fenced")
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null)
      const reason =
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof body.error === "string" &&
        bridgeDiagnostics.has(body.error)
          ? `: ${body.error}`
          : ""
      const message = `Bridge refused ${input === undefined && !archive ? "GET" : "POST"} ${path} (${response.status})${reason}`
      console.warn(message)
      throw new ProtocolError(response.status >= 500 ? "transport" : "blocked", message)
    }
    return response
  }
  private async raw(binding: Binding, path: string, input?: unknown) {
    return (await this.request(binding, path, input)).json()
  }
  private async snapshot(
    binding: Binding,
    captures: ReadonlyArray<{ name: string; base64: string }> = [],
  ): Promise<Archive> {
    const response = await this.request(binding, "/checkpoint", { captures })
    const sha256 = response.headers.get("x-archive-sha256")
    const size = Number(response.headers.get("content-length"))
    if (
      !response.body ||
      !sha256 ||
      !/^[a-f0-9]{64}$/.test(sha256) ||
      !Number.isSafeInteger(size) ||
      size <= 0
    )
      throw new ProtocolError("blocked", "Invalid bridge archive headers")
    return { body: response.body, sha256, size }
  }
  async connect(): Promise<Binding> {
    if (this.connecting) return this.connecting
    this.connecting = this.open().finally(() => {
      this.connecting = undefined
    })
    return this.connecting
  }
  private async open(): Promise<Binding> {
    await this.authority(false)
    const association = await this.publication.workspace()
    const checkout = association
      ? {
          branch: association.branch,
          ...(association.headRepositoryId !== this.selected.repositoryId
            ? { pullRequestNumber: association.number }
            : {}),
        }
      : {}
    let binding = await this.storage.get<Binding>("_janitor_workspace")
    if (binding?.destroyed) throw new ProtocolError("stale_generation", "Workspace was destroyed")
    if (!binding) {
      binding = {
        resource: await resourceName(this.selected),
        token: crypto.randomUUID(),
        selected: this.selected,
      }
      await this.storage.put("_janitor_workspace", binding)
    }
    if (JSON.stringify(binding.selected) !== JSON.stringify(this.selected))
      throw new ProtocolError("stale_generation", "Workspace selection changed")
    const sandbox = this.sandbox(binding)
    const process =
      (await sandbox.getProcess?.("janitor-bridge")) ??
      (await sandbox.startProcess("node /opt/janitor/entry.mjs", {
        processId: "janitor-bridge",
        env: {
          JANITOR_BRIDGE_TOKEN: binding.token,
          JANITOR_GENERATION: String(this.selected.generation),
        },
      }))
    await process.waitForPort(8788, { mode: "tcp" })
    const meta = (await this.raw(binding, "/meta")) as Meta
    checkBridge(meta, this.selected.generation)
    if (this.checkpoints.uncertain() && !this.activeTool)
      this.hold("Tool operation requires reconciliation before native recovery")
    if (binding.epoch && binding.epoch !== meta.epoch) {
      if (this.checkpoints.uncertain())
        this.hold("Bridge epoch changed during an admitted tool operation")
      if (
        this.storage.sql
          .exec("SELECT id FROM _janitor_operation WHERE state = 'admitted' LIMIT 1")
          .toArray().length
      )
        this.hold("Bridge epoch changed; workspace operations require reconciliation")
      const archive = await this.checkpoints.restore()
      if (!archive) this.hold("Bridge epoch changed without a committed workspace")
      await this.request({ ...binding, epoch: meta.epoch }, "/restore", undefined, archive)
    }
    // Native tool execution can lazily connect its environment after tool admission.
    if (this.activeTool && binding.epoch === meta.epoch) return binding
    binding.epoch = meta.epoch
    await this.storage.put("_janitor_workspace", binding)
    if (
      this.storage.sql
        .exec(
          "SELECT id FROM _janitor_operation WHERE state = 'admitted' AND id <> 'clone' LIMIT 1",
        )
        .toArray().length
    )
      this.hold("An admitted bridge operation requires reconciliation before native recovery")
    const clone = (await this.raw(binding, "/repository")) as { ready: boolean }
    if (!clone.ready) {
      const repository = await this.authority(true)
      if (!repository.token) throw new ProtocolError("blocked", "Repository credential missing")
      // The token is never persisted in the runner's operation payload or Sandbox journal.
      const payload = {
        owner: repository.owner,
        repo: repository.repo,
        repositoryId: this.selected.repositoryId,
        ...checkout,
      }
      const identity = await payloadHash(payload)
      const prior = this.storage.sql
        .exec<{ payload_hash: string; epoch: string }>(
          "SELECT * FROM _janitor_operation WHERE id = 'clone'",
        )
        .toArray()[0]
      if (prior && (prior.payload_hash !== identity || prior.epoch !== binding.epoch))
        this.hold("Clone identity changed before its outcome was reconciled")
      this.storage.sql.exec(
        "INSERT OR IGNORE INTO _janitor_operation VALUES ('clone', ?, ?, ?, 'admitted', NULL)",
        binding.epoch,
        identity,
        JSON.stringify(payload),
      )
      await this.storage.sync()
      await this.raw(binding, "/clone", {
        owner: repository.owner,
        repo: repository.repo,
        token: repository.token,
        ...checkout,
      })
    }
    this.storage.sql.exec(
      "UPDATE _janitor_operation SET state = 'complete', result = ? WHERE id = 'clone'",
      JSON.stringify({ ready: true }),
    )
    await this.storage.sync()
    if (!this.checkpoints.current()) {
      const archive = await this.snapshot(binding)
      await this.checkpoints.commit(archive, binding.resource)
    }
    await this.raw(binding, "/thaw", {})
    await this.checkpoints.prune()
    return binding
  }
  readonly rpc: BridgeRpc = async <A>(path: string, input?: unknown): Promise<A> => {
    if (path === "/process") input = { ...(input as object), timeout: this.toolTimeout }
    if (path === "/process" || path === "/resolve") await this.authority(false)
    const binding = await this.storage.get<Binding>("_janitor_workspace")
    if (!binding?.epoch || binding.destroyed)
      throw new ProtocolError("blocked", "Workspace is not connected")
    const meta = (await this.raw(binding, "/meta")) as Meta
    checkBridge(meta, this.selected.generation)
    if (meta.epoch !== binding.epoch) this.hold("Bridge epoch changed; replay refused")
    let id: string | undefined
    if (input !== undefined && path !== "/resolve") {
      const identity = await payloadHash({ path, input })
      const body = input as { id?: string; seq?: number }
      id = path === "/process" ? `process:${body.id}` : `${path}:${body.seq ?? identity}`
      if (
        path === "/process" &&
        this.storage.sql
          .exec<{ id: string }>(
            "SELECT id FROM _janitor_operation WHERE state = 'admitted' AND id <> ?",
            id,
          )
          .toArray()
          .some((row) => !this.inFlight.has(row.id))
      )
        this.hold("An earlier bridge operation requires reconciliation")
      const previous = this.storage.sql
        .exec<{ payload_hash: string; epoch: string; state: string; result: string | null }>(
          "SELECT * FROM _janitor_operation WHERE id = ?",
          id,
        )
        .toArray()[0]
      if (previous && (previous.payload_hash !== identity || previous.epoch !== binding.epoch))
        throw new ProtocolError("blocked", "Operation payload or epoch changed; replay refused")
      if (previous?.state === "complete") return JSON.parse(previous.result!) as A
      this.storage.sql.exec(
        "INSERT OR IGNORE INTO _janitor_operation VALUES (?, ?, ?, ?, 'admitted', NULL)",
        id,
        binding.epoch,
        identity,
        JSON.stringify({ path, input }),
      )
      this.inFlight.add(id)
      await this.storage.sync().catch((cause) => {
        this.inFlight.delete(id!)
        throw cause
      })
    }
    try {
      const result = await this.raw(binding, path, input).catch(async (cause) => {
        if (cause instanceof ProtocolError && cause.code !== "transport") throw cause
        const current = (await this.raw(binding, "/meta")) as Meta
        checkBridge(current, this.selected.generation)
        if (current.epoch !== binding.epoch) this.hold("Bridge epoch changed after a lost reply")
        // Reuse the exact admitted identity. The same-epoch bridge retrieves its journal receipt.
        return this.raw(binding, path, input)
      })
      if (id) {
        this.storage.sql.exec(
          "UPDATE _janitor_operation SET state = 'complete', result = ? WHERE id = ?",
          JSON.stringify(result),
          id,
        )
        await this.storage.sync()
      }
      return result as A
    } finally {
      if (id) this.inFlight.delete(id)
    }
  }
  async admitTool(id: string, input: unknown, timeout = DEFAULT_TOOL_TIMEOUT_MS) {
    // Under a maintenance hold no fresh tool operation is admitted: like a model
    // request, it waits for the drain to dispose the runtime, which interrupts
    // it as a shutdown. Nothing is recorded, so nothing becomes uncertain.
    if (new RunnerStorage(this.storage).maintenance.held) await new Promise<never>(() => {})
    await this.publication.guard()
    await this.authority(false)
    const result = await this.checkpoints.admit(id, input)
    this.toolTimeout = timeout
    if (result === undefined) this.activeTool = id
    return result
  }
  async finishTool(
    id: string,
    result: string,
    captures: ReadonlyArray<{ name: string; base64: string }>,
  ) {
    const binding = await this.storage.get<Binding>("_janitor_workspace")
    if (!binding?.epoch || binding.destroyed) this.hold("Workspace unavailable before checkpoint")
    try {
      const archive = await this.snapshot(binding, captures)
      await this.checkpoints.commit(archive, binding.resource, { id, result })
      await this.raw(binding, "/thaw", {})
    } catch (cause) {
      this.hold(`Workspace checkpoint failed; operation requires reconciliation: ${String(cause)}`)
    } finally {
      this.activeTool = undefined
    }
  }
  releaseTool() {
    this.activeTool = undefined
  }
  async thaw() {
    const binding = await this.storage.get<Binding>("_janitor_workspace")
    if (binding?.epoch && !binding.destroyed) await this.raw(binding, "/thaw", {})
  }
  async destroy() {
    let binding = await this.storage.get<Binding>("_janitor_workspace")
    if (!binding)
      binding = {
        resource: await resourceName(this.selected),
        token: "",
        selected: this.selected,
      }
    await this.storage.put("_janitor_workspace", { ...binding, destroyed: true })
    await this.sandbox(binding).destroy()
    await this.checkpoints.prune(true)
  }
  driver() {
    const attempt = <A>(run: () => Promise<A>) =>
      Effect.tryPromise({
        try: run,
        catch: (cause) => new WorkspaceDriver.Error({ message: String(cause) }),
      })
    return WorkspaceDriver.make({
      create: () =>
        attempt(async () => {
          const binding = await this.connect()
          return { binding: { resource: binding.resource } }
        }),
      connect: () =>
        attempt(async () => {
          await this.connect()
          return { spawner: makeRemoteSpawner(this.rpc) }
        }),
      suspendForIdle: () => Effect.void,
      destroy: () => attempt(() => this.destroy()),
    })
  }
}
