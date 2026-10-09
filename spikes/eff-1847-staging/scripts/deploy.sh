#!/usr/bin/env bash
# Deploys (or destroys) the EFF-1847 staging stack, after checking that the
# alchemy profile points at the staging account and not at janitor's
# production account.
#
#   scripts/deploy.sh deploy   # needs EXECUTOR_URL in the environment
#   scripts/deploy.sh destroy
set -euo pipefail
cd "$(dirname "$0")/.."

STAGING_ACCOUNT="5ad30d3f62c758ace435e2530ffa0a58"   # "Tim.smart@effectful.co's Account"
PRODUCTION_ACCOUNT="a5324318f7f0ddf25e7a1ba5359d1aa5" # janitor production (GitHub env `production`)
PROFILE="${ALCHEMY_PROFILE:-default}"
profile_account=$(jq -r .values.accountId "$HOME/.alchemy/profiles/$PROFILE/cloudflare.json")

if [[ "$profile_account" == "$PRODUCTION_ACCOUNT" ]]; then
  echo "refusing: alchemy profile '$PROFILE' points at the production account" >&2
  exit 1
fi
if [[ "$profile_account" != "$STAGING_ACCOUNT" ]]; then
  echo "refusing: alchemy profile '$PROFILE' points at unknown account $profile_account" >&2
  exit 1
fi
if [[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" && "$CLOUDFLARE_ACCOUNT_ID" != "$STAGING_ACCOUNT" ]]; then
  echo "refusing: CLOUDFLARE_ACCOUNT_ID in the shell is not the staging account" >&2
  exit 1
fi
echo "account check: profile '$PROFILE' -> $profile_account (staging)"

case "${1:-}" in
  deploy)
    : "${EXECUTOR_URL:?set EXECUTOR_URL to the executor tunnel URL}"
    export DEPLOY_MARKER="${DEPLOY_MARKER:-$(date -u +%Y%m%dT%H%M%SZ)}"
    echo "deploying with DEPLOY_MARKER=$DEPLOY_MARKER EXECUTOR_URL=$EXECUTOR_URL"
    exec pnpm exec alchemy deploy --stage staging --yes --no-input --profile "$PROFILE"
    ;;
  destroy)
    # The stack module reads EXECUTOR_URL while planning; any value will do.
    export EXECUTOR_URL="${EXECUTOR_URL:-http://destroyed.invalid}"
    exec pnpm exec alchemy destroy --stage staging --yes --no-input --profile "$PROFILE"
    ;;
  *)
    echo "usage: $0 deploy|destroy" >&2
    exit 2
    ;;
esac
