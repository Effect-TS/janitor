/**
 * The voice transport probe. It joins one test voice channel, receives
 * audio, and reports whether each step of Discord voice works from where it
 * runs. It keeps no audio: Opus frames that DAVE authenticated are decoded to
 * measure their level and the samples are dropped at once. There is no
 * speech-to-text. Events, stdout and the status hold counts, timings, codes
 * from the allowlist in codes.ts, per-run aliases instead of Discord ids, and
 * addresses without their last octet; no text from errors or the library.
 *
 * HTTP on PORT, for the Durable Object that owns the container:
 *   GET  /healthz
 *   GET  /events?boot=<id>&after=<seq>  events since the cursor, plus a snapshot
 *   POST /drop     closes the voice WebSocket abruptly; the library should resume
 *   POST /rejoin   destroys the voice connection and joins again
 *   POST /stun     repeats the STUN checks
 */
import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import {
  DAVESession,
  EndBehaviorType,
  joinVoiceChannel,
  NetworkingStatusCode,
  VoiceConnectionStatus,
  VoiceUDPSocket,
  entersState,
  type VoiceConnection,
  type VoiceConnectionState,
  version as voiceVersion,
} from "@discordjs/voice"
import { type DecryptionStats, VERSION as daveyVersion } from "@snazzah/davey"
import {
  Client,
  Events,
  GatewayIntentBits,
  type Guild,
  version as discordjsVersion,
} from "discord.js"
import OpusScript from "opusscript"
import {
  aliaser,
  classifyDecrypt,
  daveMessage,
  errorCode,
  isRtpOpus,
  maskAddress,
} from "./filters.ts"
import { probeStun, STUN_SERVERS } from "./stun.ts"

const required = (name: string): string => {
  const value = process.env[name]
  if (!value) {
    console.error(`${name} is not set`)
    process.exit(1)
  }
  return value
}

const token = required("DISCORD_BOT_TOKEN")
const guildId = required("DISCORD_GUILD_ID")
const channelId = required("DISCORD_CHANNEL_ID")
const port = Number(process.env.PORT ?? 8080)
/**
 * When this process leaves the call and exits, whatever the Durable Object
 * does: the object passes its own time limit plus a margin, so a probe whose
 * object stopped polling still ends.
 */
const stopAt = Number(required("STOP_AT"))
/** Per-run salt for user aliases, from the Durable Object, so aliases survive restarts within a run. */
const alias = aliaser(required("ALIAS_SALT"))
/** How long leaving the call may take before the process exits regardless. */
const SHUTDOWN_GRACE_MS = 5_000
/**
 * Works around discordjs/discord.js#11653: after an MLS welcome at
 * transition 0, which is what a bot joining a channel with someone already in
 * it receives, `lastTransitionId` is 0 and the library never recovers from
 * decrypt failures. When on, a decrypt failure past the tolerance at
 * transition 0 starts the library's own recovery instead of throwing.
 */
const transitionZeroFix = process.env.TRANSITION_ZERO_FIX === "1"

/** A frame whose RMS level is above this counts as voiced (int16 samples). */
const VOICED_RMS = 300
const IP_DISCOVERY_TIMEOUT_MS = 10_000
const MAX_EVENTS = 5_000

// Events

const bootId = randomUUID().slice(0, 8)
let seq = 0
const events: Array<Record<string, unknown>> = []

const emit = (kind: string, detail: Record<string, unknown> = {}) => {
  const event = { seq: ++seq, at: Date.now(), bootId, kind, ...detail }
  events.push(event)
  if (events.length > MAX_EVENTS) events.shift()
  console.log(JSON.stringify(event))
}

// Counters, reset at the start of each voice epoch (every time the voice
// connection becomes ready, after a join or a resume)

interface UserCounters {
  /** Packets davey authenticated and decrypted. */
  e2eeOk: number
  /** Decrypt attempts that threw or returned nothing. */
  e2eeFail: number
  /** Packets that went through without end-to-end decryption. */
  passthrough: number
  streamErrors: number
  opusFail: number
  /** Authenticated packets whose decoded audio is above VOICED_RMS. */
  voicedFrames: number
  lastVoicedAt: number | null
  /** The latest end-to-end attempt; passthrough doesn't change it. */
  lastResult: "ok" | "fail" | null
}

const newCounters = (): UserCounters => ({
  e2eeOk: 0,
  e2eeFail: 0,
  passthrough: 0,
  streamErrors: 0,
  opusFail: 0,
  voicedFrames: 0,
  lastVoicedAt: null,
  lastResult: null,
})

let epoch = 0
let epochStartedAt: number | null = null
let users = new Map<string, UserCounters>()
/** RTP Opus datagrams only: not the IP discovery reply or anything else. */
let rtpIn = 0
let rtpInTotal = 0
let daveProtocolVersion: number | null = null
/** Who was in the channel when the current connection asked to join. */
let rosterAtJoin: Array<string> = []

const countersFor = (userId: string) => {
  let counters = users.get(userId)
  if (!counters) {
    counters = newCounters()
    users.set(userId, counters)
  }
  return counters
}

const startEpoch = (via: "join" | "resume") => {
  epoch++
  epochStartedAt = Date.now()
  users = new Map()
  rtpIn = 0
  // A join's roster is who was there before the bot asked to join, so
  // someone who arrives during the handshake doesn't count as already present.
  const roster = via === "join" ? rosterAtJoin : presentUserIds()
  emit("ready", { epoch, via, roster, daveProtocolVersion })
}

// Instrumentation of @discordjs/voice. These wrap internals that are stable
// in 0.19.x; package.json pins the version.

interface DaveInternals {
  session?: {
    ready: boolean
    getDecryptionStats(userId: string): DecryptionStats | null
  }
  protocolVersion: number
  lastTransitionId?: number | undefined
  recoverFromInvalidTransition(transitionId: number): void
}

const SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe])
const decoders = new Map<string, OpusScript>()

/** Decodes one authenticated Opus frame, keeps only whether it was voiced, and drops the samples. */
const measure = (userId: string, counters: UserCounters, frame: Buffer) => {
  let decoder = decoders.get(userId)
  if (!decoder) {
    decoder = new OpusScript(48_000, 2, OpusScript.Application.VOIP)
    decoders.set(userId, decoder)
  }
  try {
    const pcm = Buffer.from(decoder.decode(frame))
    const samples = pcm.length >> 1
    let sum = 0
    for (let offset = 0; offset < samples * 2; offset += 2) {
      const sample = pcm.readInt16LE(offset)
      sum += sample * sample
    }
    if (samples > 0 && Math.sqrt(sum / samples) > VOICED_RMS) {
      counters.voicedFrames++
      counters.lastVoicedAt = Date.now()
    }
  } catch {
    counters.opusFail++
  }
}

/**
 * Classifies every packet by what davey itself counted during the call:
 * `successes` went up means it authenticated and decrypted the frame, and
 * `passthroughs` means it let plaintext through (a transition, or a sender
 * without DAVE). A non-null result alone proves nothing.
 */
const decrypt = DAVESession.prototype.decrypt
DAVESession.prototype.decrypt = function (this: DAVESession, packet: Buffer, userId: string) {
  const dave = this as unknown as DaveInternals
  daveProtocolVersion = dave.protocolVersion
  if (packet.equals(SILENCE_FRAME)) return decrypt.call(this, packet, userId)
  const speaker = alias(userId)
  const counters = countersFor(speaker)
  const fail = () => {
    counters.e2eeFail++
    counters.lastResult = "fail"
  }
  let classified: ReturnType<typeof classifyDecrypt<Buffer>>
  try {
    classified = classifyDecrypt(
      () => decrypt.call(this, packet, userId),
      () => dave.session?.getDecryptionStats(userId)?.successes,
    )
  } catch (error) {
    fail()
    if (transitionZeroFix && dave.lastTransitionId === 0) {
      emit("fix-applied", { epoch, userId: speaker })
      dave.recoverFromInvalidTransition(0)
      return null
    }
    throw error
  }
  const { result, outcome } = classified
  if (outcome === "authenticated") {
    if (counters.e2eeOk === 0) {
      emit("first-decrypt", {
        epoch,
        userId: speaker,
        msSinceReady: Date.now() - (epochStartedAt ?? 0),
      })
    }
    counters.e2eeOk++
    counters.lastResult = "ok"
    measure(userId, counters, result!)
  } else if (outcome === "passthrough") counters.passthrough++
  else fail()
  return result
}

interface UdpInternals {
  onMessage(buffer: Buffer): void
}

const udpPrototype = VoiceUDPSocket.prototype as unknown as UdpInternals
const onUdpMessage = udpPrototype.onMessage
udpPrototype.onMessage = function (this: UdpInternals, buffer: Buffer) {
  if (isRtpOpus(buffer)) {
    rtpIn++
    rtpInTotal++
  }
  return onUdpMessage.call(this, buffer)
}

const performIPDiscovery = VoiceUDPSocket.prototype.performIPDiscovery
VoiceUDPSocket.prototype.performIPDiscovery = function (this: VoiceUDPSocket, ssrc: number) {
  const started = Date.now()
  const timer = setTimeout(
    () => emit("ip-discovery", { ok: false, error: "NoReply", afterMs: IP_DISCOVERY_TIMEOUT_MS }),
    IP_DISCOVERY_TIMEOUT_MS,
  )
  return performIPDiscovery.call(this, ssrc).then(
    (config) => {
      clearTimeout(timer)
      emit("ip-discovery", {
        ok: true,
        ms: Date.now() - started,
        address: maskAddress(config.ip),
      })
      return config
    },
    (error: unknown) => {
      clearTimeout(timer)
      emit("ip-discovery", { ok: false, error: errorCode(error) })
      throw error
    },
  )
}

// Discord

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
})
let guild: Guild | undefined
let connection: VoiceConnection | undefined
let shuttingDown = false
let rejoinTimer: NodeJS.Timeout | undefined

/** The people (not bots) in the test channel right now, from the gateway's voice states. */
const presentUserIds = (): Array<string> =>
  guild
    ? [...guild.voiceStates.cache.values()]
        .filter(
          (state) =>
            state.channelId === channelId &&
            state.id !== client.user?.id &&
            state.member?.user.bot !== true,
        )
        .map((state) => alias(state.id))
    : []

const networkingOf = (state: VoiceConnectionState) =>
  "networking" in state ? state.networking : undefined

const join = (reason: string) => {
  clearTimeout(rejoinTimer)
  if (shuttingDown || !guild) return
  rosterAtJoin = presentUserIds()
  emit("join", { reason, roster: rosterAtJoin })
  const current = joinVoiceChannel({
    guildId,
    channelId,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: true,
    daveEncryption: true,
    debug: true,
  })
  connection = current
  const watched = new WeakSet<object>()

  current.on("debug", (message) => {
    // Only the DAVE session's own messages: WebSocket debug lines carry
    // payloads, including the voice token. Decrypt failures are counted instead.
    if (message.startsWith("[NW] [DAVE] ") && !message.includes("Failed to decrypt")) {
      emit("dave", { epoch, message: daveMessage(message.slice(12)) })
    }
  })
  current.on("error", (error) => emit("error", { source: "voice", code: errorCode(error) }))

  current.on("stateChange", (oldState, newState) => {
    if (oldState.status !== newState.status) {
      emit("connection", { from: oldState.status, to: newState.status })
    }
    const networking = networkingOf(newState)
    if (networking && !watched.has(networking)) {
      watched.add(networking)
      networking.on("stateChange", (oldNetworking, newNetworking) => {
        if (oldNetworking.code === newNetworking.code) return
        emit("networking", {
          from: NetworkingStatusCode[oldNetworking.code],
          to: NetworkingStatusCode[newNetworking.code],
        })
        if (newNetworking.code === NetworkingStatusCode.Ready) {
          daveProtocolVersion = newNetworking.dave?.protocolVersion ?? 0
          startEpoch(oldNetworking.code === NetworkingStatusCode.Resuming ? "resume" : "join")
        }
      })
    }
    if (newState.status === VoiceConnectionStatus.Disconnected && connection === current) {
      // The documented recovery: a move or a reconnect signals again within
      // seconds; anything else means the connection is gone.
      Promise.race([
        entersState(current, VoiceConnectionStatus.Signalling, 5_000),
        entersState(current, VoiceConnectionStatus.Connecting, 5_000),
      ]).catch(() => {
        if (connection === current) current.destroy()
      })
    }
    if (newState.status === VoiceConnectionStatus.Destroyed && connection === current) {
      connection = undefined
      emit("left", { reason: "destroyed" })
      rejoinTimer = setTimeout(() => join("recover"), 2_000)
    }
  })

  current.receiver.speaking.on("start", (userId) => subscribe(current, userId))
}

/**
 * Subscribes to a speaker so the receiver decrypts their packets (it skips
 * anyone without a subscription). The frames themselves are discarded; the
 * decrypt wrapper has already measured them. A broken stream is counted and
 * the next packet subscribes again.
 */
const subscribe = (current: VoiceConnection, userId: string) => {
  if (current.receiver.subscriptions.has(userId)) return
  const stream = current.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } })
  stream.resume()
  stream.on("error", (error) => {
    countersFor(alias(userId)).streamErrors++
    emit("stream-error", { epoch, userId: alias(userId), code: errorCode(error) })
  })
}

client.on(Events.ClientReady, async () => {
  emit("gateway", { state: "ready" })
  try {
    guild = await client.guilds.fetch(guildId)
    const channel = await guild.channels.fetch(channelId)
    if (!channel?.isVoiceBased())
      throw Object.assign(
        new Error("DISCORD_CHANNEL_ID is not a voice channel in DISCORD_GUILD_ID"),
        { code: "NotVoiceChannel" },
      )
    join("start")
  } catch (error) {
    emit("error", { source: "setup", code: errorCode(error) })
  }
})
client.on(Events.ShardDisconnect, (event) =>
  emit("gateway", { state: "disconnect", code: event.code }),
)
client.on(Events.ShardReconnecting, () => emit("gateway", { state: "reconnecting" }))
client.on(Events.ShardResume, () => emit("gateway", { state: "resumed" }))
client.on(Events.Error, (error) => emit("error", { source: "gateway", code: errorCode(error) }))

const runStun = async () => {
  for (const server of STUN_SERVERS) {
    const result = await probeStun(server.host, server.port)
    emit(
      "stun",
      result.ok
        ? { server: result.server, ok: true, mapped: maskAddress(result.mapped), ms: result.ms }
        : { server: result.server, ok: false, error: result.error },
    )
  }
}

// HTTP for the Durable Object

const snapshot = () => {
  const networking = connection ? networkingOf(connection.state) : undefined
  return {
    at: Date.now(),
    bootId,
    transitionZeroFix,
    connection: connection?.state.status ?? null,
    networking: networking ? NetworkingStatusCode[networking.state.code] : null,
    daveProtocolVersion,
    epoch,
    epochStartedAt,
    rtpIn,
    rtpInTotal,
    presentUserIds: presentUserIds(),
    users: Object.fromEntries(users),
  }
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://container")
  const reply = (status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" })
    response.end(JSON.stringify(body))
  }
  const route = `${request.method} ${url.pathname}`
  switch (route) {
    case "GET /healthz":
      return reply(200, { bootId })
    case "GET /events": {
      const after =
        url.searchParams.get("boot") === bootId ? Number(url.searchParams.get("after") ?? 0) : 0
      return reply(200, {
        bootId,
        events: events.filter((event) => (event.seq as number) > after),
        snapshot: snapshot(),
      })
    }
    case "POST /drop": {
      const networking = connection ? networkingOf(connection.state) : undefined
      const socket =
        networking && "ws" in networking.state
          ? (networking.state.ws as unknown as { ws: { terminate(): void } }).ws
          : undefined
      if (!socket) return reply(409, { error: "no voice WebSocket to drop" })
      emit("disruption", { type: "ws-drop", present: presentUserIds() })
      socket.terminate()
      return reply(200, { ok: true })
    }
    case "POST /rejoin": {
      emit("disruption", { type: "rejoin", present: presentUserIds() })
      const previous = connection
      connection = undefined
      previous?.destroy()
      rejoinTimer = setTimeout(() => join("rejoin"), 1_000)
      return reply(200, { ok: true })
    }
    case "POST /stun":
      void runStun()
      return reply(202, { ok: true })
    default:
      return reply(404, { error: `no route ${route}` })
  }
})

const shutdown = (signal: string) => {
  if (shuttingDown) return
  shuttingDown = true
  emit("shutdown", { signal })
  clearTimeout(rejoinTimer)
  const previous = connection
  connection = undefined
  previous?.destroy()
  // Exit regardless once the grace period is over, even if Discord cleanup hangs.
  setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref()
  // Leave the gateway a moment to send the voice state update that leaves the channel.
  setTimeout(() => {
    void client.destroy().finally(() => process.exit(0))
  }, 1_000)
}
process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGINT", () => shutdown("SIGINT"))
setTimeout(() => shutdown("deadline"), Math.max(0, stopAt - Date.now()))

emit("boot", {
  transitionZeroFix,
  stopAt,
  node: process.version,
  versions: { voice: voiceVersion, davey: daveyVersion, discordjs: discordjsVersion },
})
/** A failed login stays in the events, and the process stays up so the Durable Object can collect them. */
const login = (): Promise<unknown> =>
  client.login(token).catch((error: unknown) => {
    emit("error", { source: "login", code: errorCode(error) })
    if ((error as { code?: unknown }).code !== "TokenInvalid") setTimeout(login, 30_000)
  })

server.listen(port, () => {
  void runStun().then(login)
})
