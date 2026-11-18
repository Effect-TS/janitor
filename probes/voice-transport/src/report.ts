/**
 * Turns the probe's stored events into the result checklist. Pure, so the
 * verdicts can be checked without Discord or Cloudflare.
 *
 * Every verdict needs positive evidence of the thing it names: speech that
 * DAVE authenticated, from a named tester, inside the window a disruption
 * opened. Anything weaker is "fail" or "not run", never "pass".
 *
 * The report carries no Discord ids or full addresses: speakers become
 * "speaker 1", "speaker 2" in order of appearance, and addresses keep their
 * first three octets.
 */

/** One stored event: the container's (with a bootId) or the Durable Object's. */
export interface ProbeEvent {
  readonly at: number
  readonly kind: string
  readonly bootId?: string
  readonly [key: string]: unknown
}

export type Verdict = "pass" | "fail" | "not run"

export interface Check {
  readonly id: string
  readonly title: string
  readonly verdict: Verdict
  readonly evidence: string
}

/**
 * How one speaker fared in one voice epoch (the stretch from the connection
 * becoming ready to the next ready of the same process).
 *
 * - decrypted: DAVE authenticated voiced audio from them, and their latest end-to-end attempt succeeded
 * - failing: their latest end-to-end attempt failed (the #11653 symptom when nothing ever succeeded)
 * - unencrypted: their packets only went through without end-to-end decryption
 * - silent: no voiced, authenticated audio from them
 */
export type SpeakerResult = "decrypted" | "failing" | "unencrypted" | "silent"

export interface SpeakerOutcome {
  readonly speaker: string
  readonly result: SpeakerResult
  readonly e2eeOk: number
  readonly e2eeFail: number
  readonly passthrough: number
  readonly voicedFrames: number
  readonly msToFirstDecrypt: number | null
}

export interface Epoch {
  readonly at: number
  readonly bootId: string
  readonly epoch: number
  readonly via: "join" | "resume"
  readonly transitionZeroFix: boolean
  /** How often the transition-0 workaround actually ran in this epoch. */
  readonly fixFired: number
  /** For a join, who was there before the bot asked to join; for a resume, who was there at ready. */
  readonly present: ReadonlyArray<SpeakerOutcome>
  /** Speakers heard who are not in `present`. */
  readonly arrived: ReadonlyArray<SpeakerOutcome>
}

export interface Recovery {
  readonly at: number
  readonly type: string
  /** The ready that counts as this recovery, inside the window up to the next disruption. */
  readonly epoch: Epoch | null
  readonly readyAfterMs: number | null
  /** Why no ready in the window counts, when none does. */
  readonly problem: string | null
  /** The testers: people in the call before the disruption, as they fared afterwards. */
  readonly testers: ReadonlyArray<SpeakerOutcome>
}

export interface Report {
  readonly checks: ReadonlyArray<Check>
  readonly epochs: ReadonlyArray<Epoch>
  readonly recoveries: ReadonlyArray<Recovery>
}

interface Counters {
  readonly e2eeOk?: number
  readonly e2eeFail?: number
  readonly passthrough?: number
  readonly voicedFrames?: number
  readonly lastVoicedAt?: number | null
  readonly lastResult?: "ok" | "fail" | null
}

const DISRUPTIONS = [
  { type: "ws-drop", title: "Voice WebSocket dropped: resumes and decrypts again" },
  { type: "rejoin", title: "Voice connection destroyed and joined again: decrypts again" },
  { type: "sigterm", title: "Container stopped with SIGTERM and started: rejoins and decrypts" },
  { type: "sigkill", title: "Container killed with SIGKILL and started: rejoins and decrypts" },
] as const

const HOUR = 3_600_000

const num = (value: unknown): number => (typeof value === "number" ? value : 0)
const ids = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.map(String) : []
const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`
/** An IPv4 address with or without a port, last octet hidden. */
const mask = (address: unknown) => String(address).replace(/^(\d+\.\d+\.\d+)\.\d+(:\d+)?$/, "$1.x")

const verdictOf = (outcomes: ReadonlyArray<SpeakerOutcome>): Verdict => {
  if (outcomes.some((o) => o.result === "failing" || o.result === "unencrypted")) return "fail"
  return outcomes.some((o) => o.result === "decrypted") ? "pass" : "not run"
}

const describe = (outcomes: ReadonlyArray<SpeakerOutcome>) => {
  const parts = (["decrypted", "failing", "unencrypted", "silent"] as const)
    .map((result) => [result, outcomes.filter((o) => o.result === result).length] as const)
    .filter(([, n]) => n > 0)
    .map(([result, n]) => `${n} ${result}`)
  return parts.length > 0 ? parts.join(", ") : "nobody present"
}

export const summarize = (input: ReadonlyArray<ProbeEvent>): Report => {
  const events = [...input].sort((a, b) => a.at - b.at)
  const ofKind = (kind: string) => events.filter((event) => event.kind === kind)
  const key = (bootId: unknown, epoch: unknown) => `${String(bootId)}:${String(epoch)}`

  const labels = new Map<string, string>()
  const label = (userId: string) => {
    if (!labels.has(userId)) labels.set(userId, `speaker ${labels.size + 1}`)
    return labels.get(userId)!
  }

  const fixByBoot = new Map(ofKind("boot").map((e) => [e.bootId, e.transitionZeroFix === true]))
  const lastSnapshot = new Map<string, ProbeEvent>()
  for (const snapshot of ofKind("snapshot")) {
    lastSnapshot.set(key(snapshot.bootId, snapshot.epoch), snapshot)
  }
  const firstDecrypts = new Map(
    ofKind("first-decrypt").map((e) => [`${key(e.bootId, e.epoch)}:${String(e.userId)}`, e]),
  )
  const fixFired = (k: string) =>
    ofKind("fix-applied").filter((e) => key(e.bootId, e.epoch) === k).length

  const epochs: Array<Epoch> = ofKind("ready").map((ready) => {
    const k = key(ready.bootId, ready.epoch)
    const users = (lastSnapshot.get(k)?.users ?? {}) as Record<string, Counters>
    const roster = ids(ready.roster)
    const speaker = (userId: string): SpeakerOutcome => {
      const c = users[userId]
      const first = firstDecrypts.get(`${k}:${userId}`)
      const result: SpeakerResult =
        c?.lastResult === "fail"
          ? "failing"
          : num(c?.voicedFrames) > 0 && c?.lastResult === "ok"
            ? "decrypted"
            : num(c?.e2eeOk) === 0 && num(c?.passthrough) > 0
              ? "unencrypted"
              : "silent"
      return {
        speaker: label(userId),
        result,
        e2eeOk: num(c?.e2eeOk),
        e2eeFail: num(c?.e2eeFail),
        passthrough: num(c?.passthrough),
        voicedFrames: num(c?.voicedFrames),
        msToFirstDecrypt: first ? num(first.msSinceReady) : null,
      }
    }
    return {
      at: ready.at,
      bootId: String(ready.bootId),
      epoch: num(ready.epoch),
      via: ready.via === "resume" ? "resume" : "join",
      transitionZeroFix: fixByBoot.get(ready.bootId) ?? false,
      fixFired: fixFired(k),
      present: roster.map(speaker),
      arrived: Object.keys(users)
        .filter((userId) => !roster.includes(userId))
        .map(speaker)
        .filter((o) => o.result !== "silent"),
    }
  })

  const outcomeIn = (epoch: Epoch, speaker: string) =>
    [...epoch.present, ...epoch.arrived].find((o) => o.speaker === speaker)

  // Recoveries: each disruption owns the window up to the next one, and only
  // the kind of ready it should cause counts.
  const disruptions = ofKind("disruption")
  const recoveries: Array<Recovery> = disruptions.map((disruption, index) => {
    const end = disruptions[index + 1]?.at ?? Number.POSITIVE_INFINITY
    const before = epochs.filter((e) => e.at < disruption.at).at(-1)
    const inWindow = epochs.filter((e) => e.at > disruption.at && e.at < end)
    const type = String(disruption.type)
    let epoch: Epoch | undefined
    let problem: string | null = null
    if (type === "ws-drop") {
      epoch = inWindow.find((e) => e.via === "resume" && e.bootId === disruption.bootId)
      if (!epoch && inWindow.length > 0) problem = "came back by joining again, not by resuming"
    } else if (type === "rejoin") {
      epoch = inWindow.find((e) => e.via === "join" && e.bootId === disruption.bootId)
    } else {
      // A restart counts only with a new process, and for a signal the old one's exit observed.
      const exited = events.some(
        (e) => e.kind === "container-exit" && e.at > disruption.at && e.at < end,
      )
      epoch = inWindow.find((e) => e.via === "join" && e.bootId !== before?.bootId)
      if (epoch && type !== "unplanned-exit" && !exited) {
        epoch = undefined
        problem = "the old container's exit was not observed"
      } else if (!epoch && inWindow.length > 0) problem = "no ready from a new container"
    }
    const testerIds = before ? before.present.map((o) => o.speaker) : []
    const testers = epoch
      ? (testerIds.length > 0 ? testerIds : epoch.present.map((o) => o.speaker)).map(
          (speaker) =>
            outcomeIn(epoch!, speaker) ?? {
              speaker,
              result: "silent" as const,
              e2eeOk: 0,
              e2eeFail: 0,
              passthrough: 0,
              voicedFrames: 0,
              msToFirstDecrypt: null,
            },
        )
      : []
    return {
      at: disruption.at,
      type,
      epoch: epoch ?? null,
      readyAfterMs: epoch ? epoch.at - disruption.at : null,
      problem: epoch ? null : (problem ?? "never ready again before the next disruption"),
      testers,
    }
  })

  const checks: Array<Check> = []

  const stun = ofKind("stun")
  const stunOk = stun.filter((e) => e.ok === true)
  checks.push({
    id: "A1",
    title: "UDP round trip to a STUN server outside Cloudflare",
    verdict: stunOk.length > 0 ? "pass" : stun.length > 0 ? "fail" : "not run",
    evidence:
      stunOk.length > 0
        ? stunOk
            .map((e) => `${String(e.server)} mapped ${mask(e.mapped)} in ${num(e.ms)} ms`)
            .join("; ")
        : stun.map((e) => `${String(e.server)}: ${String(e.error)}`).join("; ") ||
          "no STUN attempt recorded",
  })

  const discovery = ofKind("ip-discovery")
  const discovered = discovery.filter((e) => e.ok === true)
  const failedDiscovery = discovery.filter((e) => e.ok !== true)
  checks.push({
    id: "A2",
    title: "Discord voice IP discovery completes",
    verdict: discovered.length > 0 ? "pass" : discovery.length > 0 ? "fail" : "not run",
    evidence:
      discovery.length === 0
        ? "no voice connection reached UDP handshaking"
        : `${discovered.length} of ${discovery.length} attempts answered` +
          (discovered.length > 0
            ? `, slowest ${Math.max(...discovered.map((e) => num(e.ms)))} ms, address ${mask(discovered.at(-1)?.address)}`
            : "") +
          (failedDiscovery.length > 0
            ? `; failures: ${failedDiscovery.map((e) => String(e.error)).join("; ")}`
            : ""),
  })

  const rtp = Math.max(0, ...ofKind("snapshot").map((e) => num(e.rtpInTotal)))
  checks.push({
    id: "A3",
    title: "Voice media (RTP Opus) from Discord arrives while someone speaks",
    verdict: rtp > 0 ? "pass" : epochs.length > 0 ? "fail" : "not run",
    evidence:
      epochs.length === 0
        ? "voice never became ready"
        : `${rtp} RTP Opus datagrams in the longest-running process (handshake and other UDP not counted)`,
  })

  const daveVersion = Math.max(
    -1,
    ...ofKind("ready").map((e) => num(e.daveProtocolVersion)),
    ...ofKind("snapshot").map((e) => num(e.daveProtocolVersion)),
  )
  checks.push({
    id: "B1",
    title: "The call negotiates DAVE end-to-end encryption",
    verdict: daveVersion >= 1 ? "pass" : epochs.length > 0 ? "fail" : "not run",
    evidence:
      daveVersion >= 0 ? `DAVE protocol version ${daveVersion}` : "voice never became ready",
  })

  const joins = epochs.filter((e) => e.via === "join")
  for (const [id, fix, labelText] of [
    ["B2", false, "with the stock library"],
    ["B3", true, "with the transition-0 workaround"],
  ] as const) {
    const sample = joins.filter((e) => e.transitionZeroFix === fix)
    const outcomes = sample.flatMap((e) => e.present)
    const fired = sample.reduce((n, e) => n + e.fixFired, 0)
    checks.push({
      id,
      title: `A speaker already in the channel before the bot joined is decrypted, ${labelText}`,
      verdict: verdictOf(outcomes),
      evidence:
        sample.length === 0
          ? "no join in this mode"
          : `${sample.length} joins: ${describe(outcomes)}` +
            (fix ? `; the workaround fired ${fired} times` : ""),
    })
  }

  const arrived = epochs.flatMap((e) => e.arrived)
  checks.push({
    id: "B4",
    title: "A speaker who joins after the bot is decrypted (optional)",
    verdict: verdictOf(arrived),
    evidence: arrived.length === 0 ? "nobody joined after the bot and spoke" : describe(arrived),
  })

  for (const [index, { type, title }] of DISRUPTIONS.entries()) {
    const sample = recoveries.filter((r) => r.type === type)
    const missed = sample.filter((r) => r.epoch === null)
    const outcomes = sample.flatMap((r) => r.testers)
    const slowest = Math.max(0, ...sample.map((r) => r.readyAfterMs ?? 0))
    checks.push({
      id: `C${index + 1}`,
      title,
      verdict: missed.length > 0 ? "fail" : verdictOf(outcomes),
      evidence:
        sample.length === 0
          ? "not triggered"
          : `${sample.length} times` +
            (missed.length > 0
              ? `, ${missed.length} did not recover (${missed.map((r) => r.problem).join("; ")})`
              : "") +
            `, slowest back to ready ${seconds(slowest)}; testers afterwards: ${describe(outcomes)}`,
    })
  }

  // D1: one process, from its first ready to authenticated speech at least an
  // hour later. Time spent out of Ready in between is reported, not hidden.
  const holds = [...new Set(epochs.map((e) => e.bootId))].map((bootId) => {
    const firstReady = epochs.find((e) => e.bootId === bootId)!.at
    const voicedAt = ofKind("snapshot")
      .filter((s) => s.bootId === bootId)
      .flatMap((s) => Object.values((s.users ?? {}) as Record<string, Counters>))
      .filter((c) => c.lastResult === "ok")
      .map((c) => num(c.lastVoicedAt))
    const lastVoiced = Math.max(0, ...voicedAt)
    let gaps = 0
    let gapMs = 0
    let leftAt: number | null = null
    for (const e of events) {
      if (e.kind !== "networking" || e.bootId !== bootId || e.at < firstReady || e.at > lastVoiced)
        continue
      if (e.from === "Ready" && leftAt === null) leftAt = e.at
      if (e.to === "Ready" && leftAt !== null) {
        gaps++
        gapMs += e.at - leftAt
        leftAt = null
      }
    }
    if (leftAt !== null) {
      gaps++
      gapMs += lastVoiced - leftAt
    }
    return { held: lastVoiced > firstReady ? lastVoiced - firstReady : 0, gaps, gapMs }
  })
  const best = holds.reduce((a, b) => (b.held > a.held ? b : a), { held: 0, gaps: 0, gapMs: 0 })
  const unplanned = recoveries.filter((r) => r.type === "unplanned-exit")
  checks.push({
    id: "D1",
    title: "One container holds the call for an hour and still decrypts speech at the end",
    verdict: best.held >= HOUR ? "pass" : "not run",
    evidence:
      `longest: speech decrypted ${minutes(best.held)} after the first ready, ${best.gaps} interruptions out of Ready totalling ${seconds(best.gapMs)}` +
      `; ${unplanned.length} unplanned container exits` +
      (unplanned.length > 0
        ? ` (${unplanned.filter((r) => r.epoch !== null).length} recovered)`
        : ""),
  })

  return { checks, epochs, recoveries }
}

const time = (at: number) => new Date(at).toISOString().slice(11, 19)
const speakers = (outcomes: ReadonlyArray<SpeakerOutcome>) =>
  outcomes.length === 0
    ? "nobody"
    : outcomes
        .map(
          (o) =>
            `${o.speaker} ${o.result} (${o.e2eeOk} authenticated, ${o.e2eeFail} failed, ${o.passthrough} passthrough, ${o.voicedFrames} voiced` +
            (o.msToFirstDecrypt === null ? ")" : `, first after ${seconds(o.msToFirstDecrypt)})`),
        )
        .join("<br>")

/** The report as Markdown, to paste into the issue. Times are UTC. */
export const renderMarkdown = (report: Report): string =>
  [
    "## Voice transport probe result",
    "",
    "| Check | Result | Evidence |",
    "| --- | --- | --- |",
    ...report.checks.map((c) => `| ${c.id} ${c.title} | ${c.verdict} | ${c.evidence} |`),
    "",
    "### Voice epochs",
    "",
    "| Ready at (UTC) | Process | Via | Workaround | Present before ready | Arrived later |",
    "| --- | --- | --- | --- | --- | --- |",
    ...report.epochs.map(
      (e) =>
        `| ${time(e.at)} | ${e.bootId} #${e.epoch} | ${e.via} | ${e.transitionZeroFix ? `on, fired ${e.fixFired}` : "off"} | ${speakers(e.present)} | ${speakers(e.arrived)} |`,
    ),
    "",
    "### Disruptions",
    "",
    "| At (UTC) | Type | Back to ready after | Testers afterwards |",
    "| --- | --- | --- | --- |",
    ...report.recoveries.map(
      (r) =>
        `| ${time(r.at)} | ${r.type} | ${r.readyAfterMs === null ? `never (${r.problem})` : seconds(r.readyAfterMs)} | ${r.epoch ? speakers(r.testers) : "-"} |`,
    ),
    "",
  ].join("\n")
