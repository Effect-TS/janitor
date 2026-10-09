#!/usr/bin/env bash
# Helpers for driving the deployed Worker. Source this file:
#   source scripts/lib.sh; call status run-1
# BASE comes from results/worker-url.txt (written after deploy).
# Run from the harness directory (zsh does not set BASH_SOURCE).
BASE="${BASE:-$(cat results/worker-url.txt 2>/dev/null || true)}"
mkdir -p results

# call <route> <run> [query] [result-name]
call() {
  local route="$1" run="$2" query="${3:-}" name="${4:-}"
  local url="$BASE/$route?run=$run${query:+&$query}"
  local out
  out=$(curl -s --max-time 170 "$url")
  if [[ -n "$name" ]]; then
    printf '%s\n' "$out" > "results/$name.json"
  fi
  printf '%s\n' "$out"
}

# brief <status-json>: one-line summary of a /status response
brief() {
  jq -c '{deploy, wallMs, build: .result.build, isolate: .result.isolate, buildAgeMs: .result.buildAgeMs, status: .result.run.status, turns: .result.run.turns, acquires: .result.run.acquires, historyRows: .result.historyRows, loop: .result.loop, tokens: {i: .result.run.input_tokens, o: .result.run.output_tokens}, lastEvent: (.result.events[-1] // null)}'
}
