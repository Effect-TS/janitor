/**
 * Turns the probe's stored events into the result checklist. Pure, so the
 * verdicts can be checked without Discord or Cloudflare.
 *
 * Every verdict needs positive evidence of the thing it names: speech that
 * DAVE authenticated, from a named tester, inside the window a disruption
 * opened. When the events can't tell outcomes apart the verdict is
 * "not proven", never "pass".
 *
 * The report carries no Discord ids, full addresses or free-form text: the
 * container already replaces ids with per-run aliases, and here speakers
 * become "speaker 1", "speaker 2", addresses keep at most their first three
 * octets, and error text keeps only its leading letters.
 */

/** One stored event: the container's (with a bootId) or the Durable Object's. */
export interface ProbeEvent {
  readonly at: number
  readonly kind: string
  readonly bootId?: string
  readonly [key: string]: unknown
}

export type Verdict = "pass" | "fail" | "not proven" | "not run"

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
  /**
   * - recovered: the right kind of ready, in the window up to the next disruption
   * - failed: it didn't come back that way
   * - not proven: the events can't show how the old container ended
   */
  readonly result: "recovered" | "failed" | "not proven"
  /** The ready that counts as this recovery, inside the window up to the next disruption. */
  readonly epoch: Epoch | null
  readonly readyAfterMs: number | null
  /** Why it failed or isn't proven. */
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
/** The longest time out of Ready that a resume may take without starting D1's clock again. */
const MAX_RESUME_GAP_MS = 30_000

const num = (value: unknown): number => (typeof value === "number" ? value : 0)
const ids = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.map(String) : []
const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`
/** An IPv4 address with at most its first three octets; anything else hidden. */
const mask = (address: unknown) =>
  String(address)
    .match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.(\d{1,3}|x)(:\d+)?$/)?.[1]
    ?.concat(".x") ?? "hidden"
/** Event text as the report may show it: its leading letters only, so no ids, addresses or payloads. */
const text = (value: unknown) =>
  String(value)
    .match(/^[A-Za-z][A-Za-z _:]*/)?.[0]
    .trim()
    .slice(0, 80) || "unrecognised"
const host = (value: unknown) =>
  /^[a-z0-9.-]{1,80}(:\d{1,5})?$/.test(String(value)) ? String(value) : "server"

/** Fail on any failing or unencrypted speaker, pass on a decrypted one, otherwise not run. */
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
  const disruptions = ofKind("disruption")
  const nextDisruption = (at: number) =>
    disruptions.find((d) => d.at > at)?.at ?? Number.POSITIVE_INFINITY

  const labels = new Map<string, string>()
  const label = (userId: string) => {
    if (!labels.has(userId)) labels.set(userId, `speaker ${labels.size + 1}`)
    return labels.get(userId)!
  }

  const fixByBoot = new Map(ofKind("boot").map((e) => [e.bootId, e.transitionZeroFix === true]))
  const firstDecrypts = new Map(
    ofKind("first-decrypt").map((e) => [`${key(e.bootId, e.epoch)}:${String(e.userId)}`, e]),
  )

  const readies = ofKind("ready")
  // An epoch's evidence is its last snapshot before the next disruption, so
  // speech after a disruption never counts for what came before it.
  const evidenceOf = (ready: ProbeEvent) => {
    const end = nextDisruption(ready.at)
    return ofKind("snapshot")
      .filter((e) => key(e.bootId, e.epoch) === key(ready.bootId, ready.epoch) && e.at < end)
      .at(-1)
  }

  const epochs: Array<Epoch> = readies.map((ready) => {
    const k = key(ready.bootId, ready.epoch)
    const end = nextDisruption(ready.at)
    const users = (evidenceOf(ready)?.users ?? {}) as Record<string, Counters>
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
        msToFirstDecrypt: first && first.at < end ? num(first.msSinceReady) : null,
      }
    }
    return {
      at: ready.at,
      bootId: String(ready.bootId),
      epoch: num(ready.epoch),
      via: ready.via === "resume" ? "resume" : "join",
      transitionZeroFix: fixByBoot.get(ready.bootId) ?? false,
      fixFired: ofKind("fix-applied").filter((e) => key(e.bootId, e.epoch) === k && e.at < end)
        .length,
      present: roster.map(speaker),
      arrived: Object.keys(users)
        .filter((userId) => !roster.includes(userId))
        .map(speaker)
        .filter((o) => o.result !== "silent"),
    }
  })

  const silent = (speaker: string): SpeakerOutcome => ({
    speaker,
    result: "silent",
    e2eeOk: 0,
    e2eeFail: 0,
    passthrough: 0,
    voicedFrames: 0,
    msToFirstDecrypt: null,
  })
  const outcomeIn = (epoch: Epoch, speaker: string) =>
    [...epoch.present, ...epoch.arrived].find((o) => o.speaker === speaker) ?? silent(speaker)

  // Recoveries: each disruption owns the window up to the next one, and only
  // the kind of ready it should cause counts.
  const recoveries: Array<Recovery> = disruptions.map((disruption, index) => {
    const end = disruptions[index + 1]?.at ?? Number.POSITIVE_INFINITY
    const before = epochs.filter((e) => e.at < disruption.at).at(-1)
    const replaced = disruption.bootId === undefined ? before?.bootId : String(disruption.bootId)
    const inWindow = epochs.filter((e) => e.at > disruption.at && e.at < end)
    const type = String(disruption.type)
    let epoch: Epoch | undefined
    let result: Recovery["result"] = "failed"
    let problem: string | null = null
    if (type === "ws-drop") {
      epoch = inWindow.find((e) => e.via === "resume" && e.bootId === replaced)
      if (!epoch && inWindow.length > 0) problem = "came back by joining again, not by resuming"
    } else if (type === "rejoin") {
      epoch = inWindow.find((e) => e.via === "join" && e.bootId === replaced)
    } else {
      epoch = inWindow.find((e) => e.via === "join" && e.bootId !== replaced)
      if (!epoch && inWindow.length > 0) problem = "no ready from a new container"
      if (epoch && type !== "unplanned-exit") {
        // A signal counts only if the container it was sent to left by itself.
        const ending = events.find(
          (e) =>
            e.kind === "container-end" &&
            e.at > disruption.at &&
            e.at < end &&
            (e.bootId === undefined || e.bootId === replaced),
        )
        if (!ending) {
          result = "not proven"
          problem = "how the old container ended was not recorded"
        } else if (ending.outcome !== "exited") {
          problem = `the container didn't exit on the signal and was ${text(ending.outcome)}`
        }
        if (problem) epoch = undefined
      }
    }
    if (epoch) result = "recovered"
    // The testers are who was in the call at the disruption.
    const testerIds = Array.isArray(disruption.present)
      ? ids(disruption.present).map(label)
      : (before?.present.map((o) => o.speaker) ?? [])
    return {
      at: disruption.at,
      type,
      result,
      epoch: epoch ?? null,
      readyAfterMs: epoch ? epoch.at - disruption.at : null,
      problem: epoch ? null : (problem ?? "never ready again before the next disruption"),
      testers: epoch ? testerIds.map((speaker) => outcomeIn(epoch!, speaker)) : [],
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
            .map((e) => `${host(e.server)} mapped ${mask(e.mapped)} in ${num(e.ms)} ms`)
            .join("; ")
        : stun.map((e) => `${host(e.server)}: ${text(e.error)}`).join("; ") ||
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
            ? `; failures: ${failedDiscovery.map((e) => text(e.error)).join("; ")}`
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
    let verdict = verdictOf(outcomes)
    // Decryption with the workaround on but never used says nothing about the workaround.
    if (fix && verdict === "pass" && fired === 0) verdict = "not proven"
    checks.push({
      id,
      title: `A speaker already in the channel before the bot joined is decrypted, ${labelText}`,
      verdict,
      evidence:
        sample.length === 0
          ? "no join in this mode"
          : `${sample.length} joins: ${describe(outcomes)}` +
            (fix
              ? `; the workaround fired ${fired} times` +
                (fired === 0 ? ", so this doesn't show whether it is needed" : "")
              : ""),
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
    const failed = sample.filter((r) => r.result === "failed")
    const unproven = sample.filter((r) => r.result === "not proven")
    const outcomes = sample.flatMap((r) => r.testers)
    const slowest = Math.max(0, ...sample.map((r) => r.readyAfterMs ?? 0))
    const verdict: Verdict =
      failed.length > 0 ? "fail" : unproven.length > 0 ? "not proven" : verdictOf(outcomes)
    checks.push({
      id: `C${index + 1}`,
      title,
      verdict,
      evidence:
        sample.length === 0
          ? "not triggered"
          : `${sample.length} times` +
            ([...failed, ...unproven].length > 0
              ? `, ${failed.length + unproven.length} not counted (${[...failed, ...unproven].map((r) => r.problem).join("; ")})`
              : "") +
            `, slowest back to ready ${seconds(slowest)}; testers afterwards: ${describe(outcomes)}`,
    })
  }

  // D1: a hold starts at a join and continues through resumes that each
  // came back within MAX_RESUME_GAP_MS. A rejoin, a new process or a longer
  // gap starts the clock again. It lasts until the last authenticated speech
  // heard within it.
  interface Hold {
    start: number
    lastSpeech: number
    resumes: number
    longestGapMs: number
  }
  const holds: Array<Hold> = []
  let hold: Hold | undefined
  let previous: ProbeEvent | undefined
  for (const ready of readies) {
    const leftReady =
      ready.via === "resume" && previous?.bootId === ready.bootId
        ? events
            .filter(
              (e) =>
                e.kind === "networking" &&
                e.bootId === ready.bootId &&
                e.from === "Ready" &&
                e.at > previous!.at &&
                e.at < ready.at,
            )
            .at(-1)
        : undefined
    const gap = leftReady ? ready.at - leftReady.at : null
    if (hold && gap !== null && gap <= MAX_RESUME_GAP_MS) {
      hold.resumes++
      hold.longestGapMs = Math.max(hold.longestGapMs, gap)
    } else {
      hold = { start: ready.at, lastSpeech: 0, resumes: 0, longestGapMs: 0 }
      holds.push(hold)
    }
    const users = (evidenceOf(ready)?.users ?? {}) as Record<string, Counters>
    for (const c of Object.values(users)) {
      if (c.lastResult === "ok" && num(c.voicedFrames) > 0) {
        hold.lastSpeech = Math.max(hold.lastSpeech, num(c.lastVoicedAt))
      }
    }
    previous = ready
  }
  const held = (h: Hold) => Math.max(0, h.lastSpeech - h.start)
  const best = holds.reduce<Hold | undefined>(
    (a, h) => (!a || held(h) > held(a) ? h : a),
    undefined,
  )
  const unplanned = recoveries.filter((r) => r.type === "unplanned-exit")
  checks.push({
    id: "D1",
    title: "One voice session holds the call for an hour and still decrypts speech at the end",
    verdict: !best ? "not run" : held(best) >= HOUR ? "pass" : "not proven",
    evidence:
      (best
        ? `longest: speech decrypted ${minutes(held(best))} after a join, through ${best.resumes} resumes (longest ${seconds(best.longestGapMs)} out of Ready)`
        : "voice never became ready") +
      `; a rejoin, a restart or more than ${seconds(MAX_RESUME_GAP_MS)} out of Ready starts the clock again` +
      `; ${unplanned.length} unplanned container exits` +
      (unplanned.length > 0
        ? ` (${unplanned.filter((r) => r.result === "recovered").length} recovered)`
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
        `| ${time(r.at)} | ${r.type} | ${r.readyAfterMs === null ? `${r.result} (${r.problem})` : seconds(r.readyAfterMs)} | ${r.epoch ? speakers(r.testers) : "-"} |`,
    ),
    "",
  ].join("\n")
