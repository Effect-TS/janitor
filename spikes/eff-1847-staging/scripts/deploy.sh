#!/usr/bin/env bash
# Deploys (or destroys) the EFF-1847 / EFF-1875 smoke-test stack.
#
# EFF-1875 runs on janitor's production Cloudflare account, the only paid
# account available. The risk is corrupting production's alchemy state or
# resources, so this script refuses to run unless:
#   - it is the harness in spikes/eff-1847-staging,
#   - the stack keeps `localState()` and never mentions `Cloudflare.state()`,
#   - the alchemy profile is `dev` and points at the expected account,
#   - no `--adopt` is passed (there is no way to pass extra flags at all).
#
#   ALCHEMY_PROFILE=dev scripts/deploy.sh deploy
#   ALCHEMY_PROFILE=dev scripts/deploy.sh destroy
set -euo pipefail
cd "$(dirname "$0")/.."

ACCOUNT="a5324318f7f0ddf25e7a1ba5359d1aa5"   # janitor's (paid) account
PROFILE_NAME="dev"

if [[ "$(basename "$PWD")" != "eff-1847-staging" || "$(basename "$(dirname "$PWD")")" != "spikes" ]]; then
  echo "refusing: not in spikes/eff-1847-staging ($PWD)" >&2
  exit 1
fi
if ! grep -q 'state: localState()' alchemy.run.ts; then
  echo "refusing: alchemy.run.ts does not use localState()" >&2
  exit 1
fi
if grep -rq 'Cloudflare\.state\|Cloudflare/State\|alchemy-state-store' alchemy.run.ts src; then
  echo "refusing: the stack references Cloudflare.state() / the shared state store" >&2
  exit 1
fi
if [[ "${ALCHEMY_PROFILE:-}" != "$PROFILE_NAME" ]]; then
  echo "refusing: set ALCHEMY_PROFILE=$PROFILE_NAME (got '${ALCHEMY_PROFILE:-}')" >&2
  exit 1
fi
profile_file="$HOME/.alchemy/profiles/$PROFILE_NAME/cloudflare.json"
profile_account=$(jq -r .values.accountId "$profile_file")
if [[ "$profile_account" != "$ACCOUNT" ]]; then
  echo "refusing: profile '$PROFILE_NAME' points at $profile_account, expected $ACCOUNT" >&2
  exit 1
fi
if [[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" && "$CLOUDFLARE_ACCOUNT_ID" != "$ACCOUNT" ]]; then
  echo "refusing: CLOUDFLARE_ACCOUNT_ID in the shell is not $ACCOUNT" >&2
  exit 1
fi
unset CLOUDFLARE_API_TOKEN CLOUDFLARE_API_KEY CLOUDFLARE_EMAIL
echo "account check: profile '$PROFILE_NAME' -> $profile_account, state: localState() in $PWD/.alchemy"

case "${1:-}" in
  deploy)
    # Before the first deploy (no local state yet), the account must not
    # already hold anything with this harness's names.
    if [[ ! -d .alchemy ]]; then
      token=$(jq -r .values.access "$profile_file")
      api="https://api.cloudflare.com/client/v4/accounts/$ACCOUNT"
      clash=$( {
        curl -sf -H "Authorization: Bearer $token" "$api/workers/scripts" | jq -r '.result[].id'
        curl -sf -H "Authorization: Bearer $token" "$api/workers/durable_objects/namespaces?per_page=1000" | jq -r '.result[].name'
        curl -sf -H "Authorization: Bearer $token" "$api/containers/applications" | jq -r '.result[]?.name'
      } | grep -i 'eff1847\|eff-1847' || true)
      if [[ -n "$clash" ]]; then
        echo "refusing: the account already has resources with this harness's names:" >&2
        echo "$clash" >&2
        exit 1
      fi
    fi
    export DEPLOY_MARKER="${DEPLOY_MARKER:-$(date -u +%Y%m%dT%H%M%SZ)}"
    echo "deploying with DEPLOY_MARKER=$DEPLOY_MARKER"
    # podman stands in for docker here; see bin/docker.
    export DOCKER_BIN="$PWD/bin/docker"
    exec pnpm exec alchemy deploy --stage staging --yes --no-input --profile "$PROFILE_NAME"
    ;;
  destroy)
    exec pnpm exec alchemy destroy --stage staging --yes --no-input --profile "$PROFILE_NAME"
    ;;
  *)
    echo "usage: ALCHEMY_PROFILE=$PROFILE_NAME $0 deploy|destroy" >&2
    exit 2
    ;;
esac
