#!/usr/bin/env bash
# Samples runs, their workspaces and held containers every 30 s.
#   bash scripts/watch-redeploy.sh <out.ndjson> <iterations> <run...> -- <held workspace...>
cd "$(dirname "$0")/.."
source scripts/lib.sh
out="$1"; n="$2"; shift 2
runs=(); held=()
while (($#)); do [[ "$1" == "--" ]] && { shift; held=("$@"); break; }; runs+=("$1"); shift; done
for ((i = 0; i < n; i++)); do
  for r in "${runs[@]}"; do
    call status "$r" | jq -c --arg r "$r" '{t: (now|strftime("%T")), run: $r, deploy: .result.deploy, build: .result.build, buildAgeS: ((.result.buildAgeMs // 0)/1000|floor), status: .result.run.status, turns: .result.run.turns, acquires: .result.run.acquires, loop: .result.loop.running, last: (.result.events[-1] | {kind, at: (.at/1000|strftime("%T")), build})}' >> "$out"
    call workspace "$r" | jq -c --arg r "$r" '{t: (now|strftime("%T")), ws: $r, obj: .result.objectInstance, running: .result.container.running, boot: .result.container.body.bootId, acquire: .result.container.body.env.ACQUIRE, lastExit: .result.lastExit}' >> "$out"
  done
  for w in "${held[@]}"; do
    call workspace "$w" | jq -c --arg w "$w" '{t: (now|strftime("%T")), ws: $w, obj: .result.objectInstance, running: .result.container.running, boot: .result.container.body.bootId, alarms: .result.alarms}' >> "$out"
  done
  sleep 30
done
