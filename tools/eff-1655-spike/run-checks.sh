#!/usr/bin/env bash
# Drives the spike Worker (alchemy dev must be running on :8955) and stores
# each response under results/. Usage: ./run-checks.sh [transport]
set -uo pipefail
cd "$(dirname "$0")"
base="http://localhost:8955"
t="${1:-http}"
mkdir -p results
get() { # name path
  local name="$1" path="$2"
  echo "=== $name  ($path)"
  curl -s --max-time 120 "$base$path" | tee "results/$name.json" | python3 -I -m json.tool 2>/dev/null | head -80 || cat "results/$name.json"
  echo
}
get "health-$t"      "/health?name=spike-$t"
get "caps-$t"        "/caps?name=spike-$t&transport=$t"
get "exec3-$t"       "/exec?name=spike-$t&transport=$t&n=3"
get "turn-$t"        "/turn?name=spike-$t&transport=$t"
get "interrupt-$t"   "/interrupt?name=spike-$t&transport=$t"
