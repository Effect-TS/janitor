#!/usr/bin/env bash
# Usage: load/run.sh <static|probe> <compat-date>
# Generates a workerd config embedding every emitted module, serves it, curls
# once, and prints the response plus workerd's startup log.
set -uo pipefail
cd "$(dirname "$0")"
entry="$1"; date="$2"
WORKERD="${WORKERD:-$(ls -d /home/tim/.local/share/pnpm/store/v11/links/@cloudflare/workerd-linux-64/1.20260918.1/*/node_modules/@cloudflare/workerd-linux-64/bin/workerd | head -1)}"
cfg="dist/$entry-$date.capnp"
{
  echo 'using Workerd = import "/workerd/workerd.capnp";'
  echo 'const config :Workerd.Config = ('
  echo '  services = [ (name = "main", worker = .mainWorker) ],'
  echo '  sockets = [ (name = "http", address = "127.0.0.1:8900", http = (), service = "main") ]'
  echo ');'
  echo 'const mainWorker :Workerd.Worker = ('
  echo '  modules = ['
  # workerd treats the FIRST module as the entry, so it must be listed first.
  { echo "$entry.js"; (cd "dist/$entry" && find . -name '*.js' | sed 's|^\./||' | grep -v "^$entry.js$" | sort); } | while read -r m; do
    echo "    (name = \"$m\", esModule = embed \"$entry/$m\"),"
  done
  echo '  ],'
  echo "  compatibilityDate = \"$date\","
  echo '  compatibilityFlags = ["nodejs_compat"],'
  echo ');'
} > "$cfg"
log="dist/$entry-$date.log"
"$WORKERD" serve "$cfg" --verbose > "$log" 2>&1 &
pid=$!
for i in $(seq 1 50); do
  if curl -s -o /dev/null http://127.0.0.1:8900/ 2>/dev/null; then break; fi
  if ! kill -0 $pid 2>/dev/null; then break; fi
  sleep 0.1
done
echo "=== $entry @ compat $date ($("$WORKERD" --version))"
if kill -0 $pid 2>/dev/null; then
  curl -s -w "\nHTTP %{http_code}\n" http://127.0.0.1:8900/
  kill $pid 2>/dev/null; wait $pid 2>/dev/null
else
  echo "workerd exited before serving (exit $(wait $pid; echo $?))"
fi
echo "--- workerd log:"
cat "$log"
