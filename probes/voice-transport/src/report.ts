/**
 * Turns the probe's stored events into the result checklist. Pure, so the
 * verdicts can be checked without Discord or Cloudflare.
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
 * becoming ready to the next join, resume or exit).
 *
 * - decrypted: end-to-end decryption succeeded and its latest attempt succeeded
 * - failing: its latest attempt failed (the #11653 symptom when nothing ever succeeded)
 * - unencrypted: packets arrived without a DAVE session
 * - silent: no packets from this speaker in the epoch
 */
export type SpeakerResult = "decrypted" | "failing" | "unencrypted" | "silent"

export interface SpeakerOutcome {
  readonly userId: string
  readonly result: SpeakerResult
  readonly e2eeOk: number
  readonly e2eeFail: number
  readonly voicedFrames: number
  readonly msToFirstDecrypt: number | null
}

export interface Epoch {
  readonly at: number
  readonly bootId: string
  readonly epoch: number
  readonly via: "join" | "resume"
  readonly transitionZeroFix: boolean
  /** People in the channel when the connection became ready. */
  readonly present: ReadonlyArray<SpeakerOutcome>
  /** People heard in the epoch who were not there when it became ready. */
  readonly arrived: ReadonlyArray<SpeakerOutcome>
}

export interface Recovery {
  readonly at: number
  readonly type: string
  readonly readyAfterMs: number | null
  readonly epoch: Epoch | null
}

export interface Report {
  readonly checks: ReadonlyArray<Check>
  readonly epochs: ReadonlyArray<Epoch>
  readonly recoveries: ReadonlyArray<Recovery>
}

interface Counters {
  readonly e2eeOk: number
  readonly e2eeFail: number
  readonly passthrough: number
  readonly voicedFrames: number
  readonly lastResult: "ok" | "fail" | null
}

const DISRUPTIONS = [
  { type: "ws-drop", title: "Voice WebSocket dropped: resumes and decrypts again" },
  { type: "rejoin", title: "Voice connection destroyed and joined again: decrypts again" },
  { type: "sigterm", title: "Container stopped with SIGTERM and started: rejoins and decrypts" },
  { type: "sigkill", title: "Container killed with SIGKILL and started: rejoins and decrypts" },
] as const

const HOUR = 3_600_000

const num = (value: unknown): number => (typeof value === "number" ? value : 0)
const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`

const outcome = (
  userId: string,
  counters: Counters | undefined,
  firstDecrypt: ProbeEvent | undefined,
): SpeakerOutcome => {
  const e2eeOk = num(counters?.e2eeOk)
  const e2eeFail = num(counters?.e2eeFail)
  const result: SpeakerResult =
    counters === undefined
      ? firstDecrypt
        ? "decrypted"
        : "silent"
      : counters.lastResult === "fail"
        ? "failing"
        : e2eeOk > 0
          ? "decrypted"
          : num(counters.passthrough) > 0
            ? "unencrypted"
            : "silent"
  return {
    userId,
    result,
    e2eeOk,
    e2eeFail,
    voicedFrames: num(counters?.voicedFrames),
    msToFirstDecrypt: firstDecrypt ? num(firstDecrypt.msSinceReady) : null,
  }
}

const verdictOf = (outcomes: ReadonlyArray<SpeakerOutcome>): Verdict => {
  if (outcomes.some((o) => o.result === "failing" || o.result === "unencrypted")) return "fail"
  return outcomes.some((o) => o.result === "decrypted") ? "pass" : "not run"
}

const describe = (outcomes: ReadonlyArray<SpeakerOutcome>) => {
  const count = (result: SpeakerResult) => outcomes.filter((o) => o.result === result).length
  const parts = (["decrypted", "failing", "unencrypted", "silent"] as const)
    .map((result) => [result, count(result)] as const)
    .filter(([, n]) => n > 0)
    .map(([result, n]) => `${n} ${result}`)
  return parts.length > 0 ? parts.join(", ") : "no speaker present"
}

export const summarize = (events: ReadonlyArray<ProbeEvent>): Report => {
  const ofKind = (kind: string) => events.filter((event) => event.kind === kind)
  const key = (bootId: unknown, epoch: unknown) => `${String(bootId)}:${String(epoch)}`

  const fixByBoot = new Map(ofKind("boot").map((e) => [e.bootId, e.transitionZeroFix === true]))
  const lastSnapshot = new Map<string, ProbeEvent>()
  for (const snapshot of ofKind("snapshot"))
    lastSnapshot.set(key(snapshot.bootId, snapshot.epoch), snapshot)
  const firstDecrypts = new Map(
    ofKind("first-decrypt").map((e) => [`${key(e.bootId, e.epoch)}:${String(e.userId)}`, e]),
  )

  const epochs: Array<Epoch> = ofKind("ready").map((ready) => {
    const k = key(ready.bootId, ready.epoch)
    const users = (lastSnapshot.get(k)?.users ?? {}) as Record<string, Counters>
    const presentIds = (ready.presentUserIds ?? []) as ReadonlyArray<string>
    const speaker = (userId: string) =>
      outcome(userId, users[userId], firstDecrypts.get(`${k}:${userId}`))
    return {
      at: ready.at,
      bootId: String(ready.bootId),
      epoch: num(ready.epoch),
      via: ready.via === "resume" ? "resume" : "join",
      transitionZeroFix: fixByBoot.get(ready.bootId) ?? false,
      present: presentIds.map(speaker),
      arrived: Object.keys(users)
        .filter((userId) => !presentIds.includes(userId))
        .map(speaker)
        .filter((o) => o.result !== "silent"),
    }
  })

  const recoveries: Array<Recovery> = ofKind("disruption").map((disruption) => {
    const epoch = epochs.find((e) => e.at > disruption.at) ?? null
    return {
      at: disruption.at,
      type: String(disruption.type),
      readyAfterMs: epoch ? epoch.at - disruption.at : null,
      epoch,
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
            .map((e) => `${String(e.server)} mapped ${String(e.mapped)} in ${num(e.ms)} ms`)
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
            ? `, slowest ${Math.max(...discovered.map((e) => num(e.ms)))} ms, address ${String(discovered.at(-1)?.address)}`
            : "") +
          (failedDiscovery.length > 0
            ? `; failures: ${failedDiscovery.map((e) => String(e.error)).join("; ")}`
            : ""),
  })

  const udpTotal = Math.max(0, ...ofKind("snapshot").map((e) => num(e.udpInTotal)))
  checks.push({
    id: "A3",
    title: "Voice UDP from Discord keeps arriving while someone speaks",
    verdict: udpTotal > 0 ? "pass" : epochs.length > 0 ? "fail" : "not run",
    evidence:
      epochs.length === 0
        ? "voice never became ready"
        : `${udpTotal} datagrams received in the longest-running process`,
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
  for (const [id, fix, label] of [
    ["B2", false, "with the stock library"],
    ["B3", true, "with the transition-0 workaround"],
  ] as const) {
    const sample = joins.filter((e) => e.transitionZeroFix === fix)
    const outcomes = sample.flatMap((e) => e.present)
    checks.push({
      id,
      title: `A speaker already in the channel is decrypted after the bot joins, ${label}`,
      verdict: verdictOf(outcomes),
      evidence:
        sample.length === 0
          ? "no join in this mode"
          : `${sample.length} joins: ${describe(outcomes)}`,
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
    const notReady = sample.filter((r) => r.epoch === null).length
    const outcomes = sample.flatMap((r) => r.epoch?.present ?? [])
    const verdict = notReady > 0 ? "fail" : verdictOf(outcomes)
    const slowest = Math.max(0, ...sample.map((r) => r.readyAfterMs ?? 0))
    checks.push({
      id: `C${index + 1}`,
      title,
      verdict,
      evidence:
        sample.length === 0
          ? "not triggered"
          : `${sample.length} times, ${notReady} never ready again, slowest back to ready ${seconds(slowest)}; ${describe(outcomes)}`,
    })
  }

  const unplanned = recoveries.filter((r) => r.type === "unplanned-exit")
  const resumes = epochs.filter(
    (e) => e.via === "resume" && !recoveries.some((r) => r.type === "ws-drop" && r.epoch === e),
  )
  const longest = Math.max(
    0,
    ...ofKind("snapshot").map((e) => (e.inChannelSince ? e.at - num(e.inChannelSince) : 0)),
  )
  checks.push({
    id: "D1",
    title: "Stays in the call for an hour",
    verdict: longest >= HOUR ? "pass" : "not run",
    evidence:
      `longest stay ${minutes(longest)}; ${unplanned.length} unplanned container exits` +
      (unplanned.length > 0
        ? ` (${unplanned.filter((r) => r.epoch !== null).length} back to ready)`
        : "") +
      `; ${resumes.length} resumes Discord started`,
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
            `${o.userId} ${o.result} (${o.e2eeOk} ok, ${o.e2eeFail} failed, ${o.voicedFrames} voiced` +
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
    "| Ready at (UTC) | Process | Via | Workaround | Present at ready | Arrived later |",
    "| --- | --- | --- | --- | --- | --- |",
    ...report.epochs.map(
      (e) =>
        `| ${time(e.at)} | ${e.bootId} #${e.epoch} | ${e.via} | ${e.transitionZeroFix ? "on" : "off"} | ${speakers(e.present)} | ${speakers(e.arrived)} |`,
    ),
    "",
    "### Disruptions",
    "",
    "| At (UTC) | Type | Back to ready after | Present speakers afterwards |",
    "| --- | --- | --- | --- |",
    ...report.recoveries.map(
      (r) =>
        `| ${time(r.at)} | ${r.type} | ${r.readyAfterMs === null ? "never" : seconds(r.readyAfterMs)} | ${r.epoch ? speakers(r.epoch.present) : "-"} |`,
    ),
    "",
  ].join("\n")
