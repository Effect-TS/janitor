#!/usr/bin/env bash
# Scratch checkout of a merged Effect-TS/effect PR for the review agent.
# The PR was squash-merged, so its merge commit is the PR's head content and
# `HEAD~1` is the base branch at merge time: `git diff HEAD~1` is the PR diff,
# and `HEAD~1:.agents/AGENTS.md` are the base branch's instructions.
set -euo pipefail
PR="${1:?usage: checkout-pr.sh <pr-number>}"
DIR="${2:-$(dirname "$0")/../scratch/pr-$PR}"
MERGE=$(gh pr view "$PR" --repo Effect-TS/effect --json mergeCommit --jq .mergeCommit.oid)
if [ ! -d "$DIR/.git" ]; then
  git clone -q --filter=blob:none --no-checkout https://github.com/Effect-TS/effect.git "$DIR"
fi
git -C "$DIR" fetch -q --depth=2 origin "$MERGE"
git -C "$DIR" checkout -q --detach "$MERGE"
git -C "$DIR" log --oneline -2
