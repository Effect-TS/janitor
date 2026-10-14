#!/usr/bin/env bash
# Drives the review runs. Usage: scripts/run-all.sh [provider] "<run>:<pr> ..."
# e.g. scripts/run-all.sh openrouter "1:9161 2:9161 3:9161 4:9143 5:9143"
# The model key comes from the environment (OPENROUTER_API_KEY or
# OPENAI_API_KEY); the sandbox gets the Effect checkout's toolchain through
# `nix develop <checkout>`.
set -uo pipefail
cd "$(dirname "$0")/.."
PROVIDER="${1:-openrouter}"
RUNS="${2:-1:9161 2:9161 3:9161 4:9143 5:9143}"
shift 2 || true
mkdir -p "results/$PROVIDER"
for spec in $RUNS; do
  run="${spec%%:*}"; pr="${spec##*:}"
  echo "== run $run on PR $pr ($PROVIDER)"
  nix develop "./scratch/pr-$pr" -c node src/run.ts --provider "$PROVIDER" --pr "$pr" --run "$run" "$@" \
    > "results/$PROVIDER/run-$run.log" 2>&1
  echo "exit $?" >> "results/$PROVIDER/run-$run.log"
  tail -20 "results/$PROVIDER/run-$run.log"
done
