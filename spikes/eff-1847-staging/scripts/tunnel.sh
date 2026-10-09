#!/usr/bin/env bash
# Starts the local executor and a cloudflared quick tunnel in front of it.
# Writes the public URL to results/tunnel-url.txt. Logs in executor.log and
# tunnel.log. Stop with: kill $(cat results/tunnel.pids)
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p results
: > results/tunnel-url.txt

node --experimental-strip-types executor/server.ts > executor.log 2>&1 &
executor_pid=$!
cloudflared tunnel --url http://localhost:${EXECUTOR_PORT:-3100} --no-autoupdate > tunnel.log 2>&1 &
tunnel_pid=$!
echo "$executor_pid $tunnel_pid" > results/tunnel.pids

for _ in $(seq 1 60); do
  url=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' tunnel.log | head -1 || true)
  if [[ -n "$url" ]]; then
    echo "$url" > results/tunnel-url.txt
    echo "executor pid $executor_pid, tunnel pid $tunnel_pid, url $url"
    exit 0
  fi
  sleep 1
done
echo "tunnel URL not found; see tunnel.log" >&2
exit 1
