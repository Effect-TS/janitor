/**
 * Replays the reply gate's eval set (EFF-3137) through the real gate: the
 * decision in `Gate.ts`, Jev on OpenRouter, as the Worker calls it. Dev-only:
 * nothing in the Worker imports it.
 *
 * Needs `OPENROUTER_API_KEY` in the environment (Infisical `janitor`,
 * `development` or `production`); `CHAT_GATE_MODEL` picks the model as in
 * the Worker:
 *
 *   node apps/cluster/scripts/chat-gate-eval.ts [--only <substring>] [--concurrency <n>] [--private <file> | --no-private]
 *
 * The checked-in set is handwritten. Real conversations stay out of Git: a
 * private corpus with the same shape (`GateEvalCorpus` in the cases module)
 * is read from `--private`, or from the gitignored
 * `chat-gate-eval.private.json` next to this script when it exists, and its
 * cases run alongside the checked-in ones.
 *
 * For every case it prints the gate's probability, the production one, and
 * whether the verdict at `GATE_PASS` matches the label. Then it sums up the
 * set at `GATE_PASS`, sweeps the threshold, scores the structural signals
 * the issue proposes against the labels, and reports drift from production.
 * Exits 1 when a case that isn't borderline gets the wrong verdict.
 */
import { existsSync, readFileSync } from "node:fs"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import type { ChatMessage } from "@janitor/domain/Chat/Session"
import { chatGateModel } from "../src/Chat/Config.ts"
import { GATE_CONTEXT, GATE_PASS, ReplyGate } from "../src/Chat/Gate.ts"
import {
  cases as checkedIn,
  threads as checkedInThreads,
  GateEvalCorpus,
  type GateEvalCase,
  type GateEvalMessage,
} from "./chat-gate-eval-cases.ts"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
const only = flag("--only")
const concurrency = Number(flag("--concurrency") ?? 4)

const apiKey = process.env.OPENROUTER_API_KEY
if (apiKey === undefined || apiKey === "") {
  console.error("OPENROUTER_API_KEY is required")
  process.exit(2)
}
const model = await Effect.runPromise(chatGateModel)

// ---- the private corpus

const privatePath = args.includes("--no-private")
  ? undefined
  : (flag("--private") ?? new URL("./chat-gate-eval.private.json", import.meta.url).pathname)
const privateCorpus =
  privatePath !== undefined && existsSync(privatePath)
    ? Effect.runSync(
        Schema.decodeUnknownEffect(GateEvalCorpus)(JSON.parse(readFileSync(privatePath, "utf8"))),
      )
    : undefined
const threads = [...checkedInThreads, ...(privateCorpus?.threads ?? [])]
const cases = [...checkedIn, ...(privateCorpus?.cases ?? [])]

// ---- the cases as the session hands them to the gate

const threadsByName = new Map(threads.map((thread) => [thread.name, thread]))

/** The thread up to and including the case's newest message, as `ChatMessage`s a minute apart. */
const contextOf = (evalCase: GateEvalCase): ReadonlyArray<ChatMessage> => {
  const thread = threadsByName.get(evalCase.thread)
  if (thread === undefined) throw new Error(`${evalCase.name}: no thread ${evalCase.thread}`)
  const end = thread.messages.findIndex((message) => message.id === evalCase.newest)
  if (end === -1) throw new Error(`${evalCase.name}: no message ${evalCase.newest}`)
  const start = DateTime.makeUnsafe("2026-01-01T00:00:00Z")
  return thread.messages.slice(0, end + 1).map((message, index) => ({
    id: message.id,
    author: { ...message.author, class: message.class },
    text: message.text,
    mentionsBot: message.mentionsBot,
    sentAt: DateTime.add(start, { minutes: index }),
    attachments: [],
  }))
}

/**
 * The structural signals the issue proposes, read off the gate's context
 * window: whether the newest message comes straight after janitor's reply to
 * its author, and how many admitted people spoke in the window.
 */
const signalsOf = (evalCase: GateEvalCase) => {
  const thread = threadsByName.get(evalCase.thread)!
  const end = thread.messages.findIndex((message) => message.id === evalCase.newest)
  const window: ReadonlyArray<GateEvalMessage> = thread.messages
    .slice(0, end + 1)
    .slice(-GATE_CONTEXT)
  const newest = window.at(-1)!
  const previous = window.at(-2)
  const followsBotReplyTo =
    previous !== undefined &&
    previous.author.id === "janitor" &&
    previous.answers === newest.author.id
  const humansInThread = new Set(
    window.filter((message) => message.class === "admitted").map((message) => message.author.id),
  ).size
  return { followsBotReplyTo, humansInThread }
}

// ---- the replay

interface Result {
  readonly evalCase: GateEvalCase
  readonly probability: number | undefined
  readonly error: string | undefined
}

const selected = cases.filter((evalCase) => only === undefined || evalCase.name.includes(only))

const results = await Effect.runPromise(
  Effect.gen(function* () {
    const gate = yield* ReplyGate
    return yield* Effect.forEach(
      selected,
      (evalCase) =>
        gate.decide(contextOf(evalCase)).pipe(
          Effect.map((probability): Result => ({ evalCase, probability, error: undefined })),
          Effect.catch((error) =>
            Effect.succeed<Result>({
              evalCase,
              probability: undefined,
              error: String(error.cause),
            }),
          ),
        ),
      { concurrency },
    )
  }).pipe(
    Effect.provide(
      ReplyGate.layer.pipe(
        Layer.provide(
          ReplyGate.decisionModel({ apiKey: Option.some(Redacted.make(apiKey)), model }),
        ),
      ),
    ),
  ),
)

// ---- the report

const percent = (n: number, of: number) => (of === 0 ? "-" : `${Math.round((n / of) * 100)}%`)
const p = (value: number | undefined) => (value === undefined ? "  - " : value.toFixed(2))

console.log(
  `Model ${model}, GATE_PASS ${GATE_PASS}, ${results.length} cases${privateCorpus === undefined ? " (no private corpus)" : ` (${privateCorpus.cases.length} from ${privatePath})`}\n`,
)
for (const { evalCase, probability, error } of results) {
  const verdict =
    probability === undefined
      ? "ERROR"
      : probability >= GATE_PASS === evalCase.expected
        ? "ok   "
        : "WRONG"
  const recorded = evalCase.recorded === undefined ? "        " : `prod ${p(evalCase.recorded)}`
  const label = evalCase.expected ? "pass  " : "reject"
  const marks = evalCase.borderline ? " (borderline)" : ""
  const note = evalCase.note === undefined ? "" : ` — ${evalCase.note}`
  console.log(
    `${verdict}  ${p(probability)}  ${recorded}  expect ${label}  ${evalCase.name}${marks}${note}`,
  )
  if (error !== undefined) console.log(`        ${error}`)
}

const scored = results.filter((result) => result.probability !== undefined)
const firm = scored.filter((result) => !result.evalCase.borderline)
const borderline = scored.filter((result) => result.evalCase.borderline)

const tally = (subset: ReadonlyArray<Result>, threshold: number) => {
  let correct = 0
  let falseNegatives = 0
  let falsePositives = 0
  for (const { evalCase, probability } of subset) {
    const passed = probability! >= threshold
    if (passed === evalCase.expected) correct++
    else if (evalCase.expected) falseNegatives++
    else falsePositives++
  }
  return { correct, falseNegatives, falsePositives, total: subset.length }
}
const line = (label: string, t: ReturnType<typeof tally>) =>
  `${label.padEnd(44)} ${String(t.correct).padStart(3)}/${String(t.total).padEnd(3)} ${percent(t.correct, t.total).padStart(4)}   false negatives ${String(t.falseNegatives).padStart(2)}   false positives ${String(t.falsePositives).padStart(2)}`

console.log(`\nAt GATE_PASS ${GATE_PASS}`)
console.log(line("  all firm cases", tally(firm, GATE_PASS)))
console.log(
  line(
    "  checked in (handwritten)",
    tally(
      firm.filter((r) => r.evalCase.source === "handwritten"),
      GATE_PASS,
    ),
  ),
)
console.log(
  line(
    "  private corpus (production)",
    tally(
      firm.filter((r) => r.evalCase.source === "production"),
      GATE_PASS,
    ),
  ),
)
console.log(line("  borderline", tally(borderline, GATE_PASS)))

// Every threshold that changes a verdict is an observed probability, so
// sweeping those covers all of 0 to 1; the fixed steps show the shape.
console.log("\nThreshold sweep, firm cases")
for (let threshold = 0.05; threshold < 1; threshold += 0.05) {
  console.log(line(`  pass at >= ${threshold.toFixed(2)}`, tally(firm, threshold)))
}
const boundaries = [...new Set(firm.map((r) => r.probability!)), 0, 1.01].sort((a, b) => a - b)
const sweep = boundaries.map((threshold) => ({ threshold, ...tally(firm, threshold) }))
const most = Math.max(...sweep.map((t) => t.correct))
const best = sweep.filter((t) => t.correct === most)
console.log(
  `  every boundary from 0 to 1 (${boundaries.length} thresholds): at most ${most}/${firm.length} correct, at ${best.map((t) => `>= ${t.threshold.toFixed(2)} (${t.falseNegatives} fn, ${t.falsePositives} fp)`).join(", ")}`,
)

console.log("\nStructural signals, firm cases")
const withSignals = firm.map((result) => ({ ...result, signals: signalsOf(result.evalCase) }))
const follows = withSignals.filter((r) => r.signals.followsBotReplyTo)
console.log(
  `  newest comes straight after janitor's reply to its author: ${follows.length} cases, ${follows.filter((r) => r.evalCase.expected).length} labelled pass, ${follows.filter((r) => !r.evalCase.expected).length} labelled reject`,
)
const alone = withSignals.filter((r) => r.signals.humansInThread === 1)
console.log(
  `  one admitted person in the window:                            ${alone.length} cases, ${alone.filter((r) => r.evalCase.expected).length} labelled pass, ${alone.filter((r) => !r.evalCase.expected).length} labelled reject`,
)
const skipping = (skip: (r: (typeof withSignals)[number]) => boolean) => {
  let correct = 0
  let falseNegatives = 0
  let falsePositives = 0
  for (const result of withSignals) {
    const passed = skip(result) || result.probability! >= GATE_PASS
    if (passed === result.evalCase.expected) correct++
    else if (result.evalCase.expected) falseNegatives++
    else falsePositives++
  }
  return { correct, falseNegatives, falsePositives, total: withSignals.length }
}
console.log(
  line(
    "  skip Jev when it follows janitor's reply",
    skipping((r) => r.signals.followsBotReplyTo),
  ),
)
console.log(
  line(
    "  skip Jev when one person is in the window",
    skipping((r) => r.signals.humansInThread === 1),
  ),
)
const missed = withSignals.filter((r) => r.evalCase.expected && r.probability! < GATE_PASS)
console.log(
  `  of the false negatives at GATE_PASS, ${missed.filter((r) => r.signals.followsBotReplyTo).length} of ${missed.length} follow janitor's reply to their author`,
)

if (scored.some((r) => r.evalCase.recorded !== undefined))
  console.log("\nDrift from the production probabilities")
const underLabels = {
  current: "  recorded by the gate as it is now",
  "#148-prompt": "  recorded with PR #148's prompt",
  "before-#148": "  recorded before PR #148, without replies in context",
} as const
for (const under of ["current", "#148-prompt", "before-#148"] as const) {
  const drift = scored.filter(
    (r) => r.evalCase.recorded !== undefined && (r.evalCase.recordedUnder ?? "current") === under,
  )
  if (drift.length === 0) continue
  const deltas = drift.map((r) => Math.abs(r.probability! - r.evalCase.recorded!))
  const flips = drift.filter(
    (r) => r.probability! >= GATE_PASS !== r.evalCase.recorded! >= GATE_PASS,
  )
  console.log(
    `${underLabels[under].padEnd(56)} ${String(drift.length).padStart(2)} cases   mean |Δ| ${(deltas.reduce((a, b) => a + b, 0) / deltas.length).toFixed(3)}   max ${Math.max(...deltas).toFixed(2)}   verdict flips ${flips.length}`,
  )
  for (const r of flips)
    console.log(
      `    ${r.evalCase.name}: now ${p(r.probability)}, production ${p(r.evalCase.recorded)}`,
    )
}

const errors = results.filter((r) => r.error !== undefined).length
if (errors > 0) console.log(`\n${errors} gate calls failed`)
const wrong = tally(firm, GATE_PASS)
process.exit(errors > 0 || wrong.falseNegatives + wrong.falsePositives > 0 ? 1 : 0)
