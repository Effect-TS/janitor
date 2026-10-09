#!/usr/bin/env bash
# Container survival with nothing holding the workspace DO: provision one
# workspace per gap, write a marker into /workspace through the executor,
# then leave each workspace untouched for its gap and check it exactly once.
#   HOLD=none|timeout|alarm bash scripts/idle-ladder.sh <prefix> <gap seconds...>
set -u
cd "$(dirname "$0")/.."
source scripts/lib.sh
prefix="$1"; shift
hold="${HOLD:-none}"
out="results/idle-$prefix.ndjson"
: > "$out"
for gap in "$@"; do
  (
    ws="$prefix-$gap"
    call workspace/provision "$ws" "acquire=1&hold=$hold" > "results/idle-$ws-provision.json"
    w=$(call probe "$ws" "kind=write&fresh=0")
    touched=$(date +%s)
    jq -c --arg ws "$ws" --argjson gap "$gap" '{ws: $ws, gap: $gap, phase: "written", at: now, output: (.result.output // .result.error // . | tostring | .[-160:])}' <<<"$w" >> "$out"
    sleep "$gap"
    s=$(call workspace "$ws")
    jq -c --arg ws "$ws" --argjson gap "$gap" --argjson idle "$(( $(date +%s) - touched ))" '{ws: $ws, gap: $gap, idleS: $idle, phase: "checked", at: now, hold: .result.hold, alarms: .result.alarms, objectInstance: .result.objectInstance, provisionedBy: .result.provision.objectInstance, sameObject: (.result.objectInstance == .result.provision.objectInstance), running: .result.container.running, bootId: .result.container.body.bootId, provisionedBoot: .result.provision.container.body.bootId, uptimeMs: .result.container.body.uptimeMs, workspace: .result.container.body.workspace, lastExit: .result.lastExit}' <<<"$s" >> "$out"
    if [[ "$(jq -r .result.container.running <<<"$s")" == "true" ]]; then
      call probe "$ws" "kind=read&fresh=0" | jq -c --arg ws "$ws" '{ws: $ws, phase: "read", output: (.result.output // .result.error | tostring | .[-200:])}' >> "$out"
    fi
  ) &
done
wait
