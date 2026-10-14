// Cross-run summary: one table over every `summary.json` under a provider's
// results directory, plus the reasoning evidence per run.
//
//   node src/summarize.ts results/openrouter

import * as fs from "node:fs"
import * as path from "node:path"
import { analyseRun, renderRun } from "./evidence.ts"
import { type TurnEvent, deriveTurns } from "./turns.ts"

const root = process.argv[2]
if (root === undefined) {
  console.error("usage: node src/summarize.ts <results/provider>")
  process.exit(2)
}

const runDirs = fs
  .readdirSync(root)
  .filter((name) => name.startsWith("run-") && fs.existsSync(path.join(root, name, "summary.json")))
  .sort((a, b) => Number(a.split("-")[1]) - Number(b.split("-")[1]))

const fmtMs = (ms: number | undefined) => (ms === undefined ? "" : `${(ms / 1000).toFixed(1)}s`)

// Timings come from the event log, the ground truth for every run.
const timingsOf = (dir: string, s: any) => {
  const events = fs
    .readFileSync(path.join(dir, "events.ndjson"), "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as TurnEvent)
  return deriveTurns(events, Date.parse(s.startedAt))
}

const lines: Array<string> = []
lines.push("## Runs", "")
lines.push(
  "| run | PR | outcome | turns | wall | model time (sum) | median model | max model | script time (sum) | retries | input tokens | output tokens | est. cost ($2/$10) | provider cost | reportFinding ok/rejected | updateThread ok/rejected |",
)
lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
const allTurns: Array<number> = []
for (const dir of runDirs) {
  const s = JSON.parse(fs.readFileSync(path.join(root, dir, "summary.json"), "utf8"))
  const evidence = analyseRun(path.join(root, dir))
  const providerCost = evidence.reduce((n, t) => n + (t.response.usage?.costUsd ?? 0), 0)
  const timings = timingsOf(path.join(root, dir), s)
  const modelMs = timings.map((t) => t.modelMs).filter((n): n is number => typeof n === "number")
  const totalMs = timings.map((t) => t.totalMs).filter((n): n is number => typeof n === "number")
  allTurns.push(...modelMs)
  const sorted = [...modelMs].sort((a, b) => a - b)
  const median = sorted.length === 0 ? undefined : sorted[Math.floor(sorted.length / 2)]
  const max = sorted.length === 0 ? undefined : sorted[sorted.length - 1]
  const count = (tool: string, outcome: string) =>
    s.toolCalls.filter((c: any) => c.tool === tool && c.outcome === outcome).length
  lines.push(
    `| ${s.run} | #${s.pr} | ${s.outcome} | ${s.turns} | ${fmtMs(s.durationMs)} | ${fmtMs(modelMs.reduce((a, b) => a + b, 0))} | ${fmtMs(median)} | ${fmtMs(max)} | ${fmtMs(totalMs.reduce((a, b) => a + b, 0) - modelMs.reduce((a, b) => a + b, 0))} | ${s.retries.length} | ${s.tokens.input} | ${s.tokens.output} | $${s.costUsdAt2in10out.totalUsd.toFixed(3)} | $${providerCost.toFixed(3)} | ${count("reportFinding", "ok")}/${count("reportFinding", "rejected")} | ${count("updateThread", "ok")}/${count("updateThread", "rejected")} |`,
  )
}
lines.push("")
if (allTurns.length > 0) {
  const sorted = [...allTurns].sort((a, b) => a - b)
  lines.push(
    `All turns: ${sorted.length}; median ${fmtMs(sorted[Math.floor(sorted.length / 2)])}, p90 ${fmtMs(sorted[Math.floor(sorted.length * 0.9)])}, max ${fmtMs(sorted[sorted.length - 1])}.`,
    "",
  )
}

lines.push("## Per-turn detail", "")
for (const dir of runDirs) {
  const s = JSON.parse(fs.readFileSync(path.join(root, dir, "summary.json"), "utf8"))
  lines.push(`### ${dir} (PR #${s.pr})`, "")
  lines.push("| turn | model | script | total | context tokens | cache read | output tokens |")
  lines.push("|---|---|---|---|---|---|---|")
  for (const t of timingsOf(path.join(root, dir), s)) {
    lines.push(
      `| ${t.turn} | ${fmtMs(t.modelMs)} | ${fmtMs(t.scriptMs)} | ${fmtMs(t.totalMs)} | ${t.contextTokens ?? ""} | ${t.cacheRead ?? ""} | ${t.outputTokens ?? ""} |`,
    )
  }
  lines.push("")
  lines.push("Tool calls:", "")
  for (const c of s.toolCalls) {
    const p = c.params as any
    const where = c.tool === "reportFinding" ? `${p.path}:${p.line}${p.endLine ? `-${p.endLine}` : ""} ${p.severity} "${p.title}"` : `${p.id}${p.resolve ? " resolve" : ""}`
    lines.push(`- ${c.tool} ${c.outcome}: ${where}${c.outcome === "rejected" ? ` → ${String(c.result).slice(0, 200)}` : ""}`)
  }
  lines.push("")
  if (s.retries.length > 0) {
    lines.push("Retries:", "")
    for (const r of s.retries) lines.push(`- ${r.error}`)
    lines.push("")
  }
  if (s.failure) lines.push("Failure:", "", "```", String(s.failure).slice(0, 3000), "```", "")
  lines.push("Verdict:", "", "> " + String(s.summary ?? "").split("\n").join("\n> "), "")
}

lines.push("## Reasoning round-trip evidence", "")
for (const dir of runDirs) {
  const turns = analyseRun(path.join(root, dir))
  fs.writeFileSync(path.join(root, dir, "evidence.json"), JSON.stringify(turns, null, 2))
  lines.push(renderRun(path.join(root, dir), turns))
}

const out = lines.join("\n")
fs.writeFileSync(path.join(root, "summary.md"), out)
console.log(out)
