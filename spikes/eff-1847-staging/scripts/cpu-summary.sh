#!/usr/bin/env bash
# CPU / wall per invocation from the tail log, by entrypoint and event kind.
#   bash scripts/cpu-summary.sh results/tail-1875.ndjson
jq -s '
  [ .[] | select(._tag == "event") | {
      what: ((.entrypoint // "Worker") + " " + (if .event.rpcMethod then "rpc " + .event.rpcMethod
              elif .event.scheduledTime then "alarm"
              elif (.event.request.url // "" | test("workers.dev")) then "front door"
              elif .entrypoint == null then "egress"
              else "fetch " + ((.event.request.url // "") | sub("^https?://[^/]+"; "") | sub("\\?.*$"; "")) end)),
      cpu: .cpuTime, wall: .wallTime, outcome, exc: ([.exceptions[]?.name] | join(","))
    } ]
  | group_by(.what)
  | map({what: .[0].what, n: length, cpuMax: (map(.cpu) | max), cpuAvg: ((map(.cpu) | add) / length | floor), wallMax: (map(.wall) | max), outcomes: (group_by(.outcome) | map({(.[0].outcome): length}) | add), exceptions: ([.[].exc | select(. != "")] | unique)})
  | sort_by(-.cpuMax)' "$1"
