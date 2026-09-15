#!/usr/bin/env bash
# Creates the bare fixture remote the local runner clones from.
set -euo pipefail
target="$1"
work="$(mktemp -d)"
git -C "$work" init --quiet --initial-branch=main
printf 'Validation code: apricot-47\n' > "$work/README.md"
git -C "$work" -c user.name=Fixture -c user.email=fixture@janitor.invalid add README.md
git -C "$work" -c user.name=Fixture -c user.email=fixture@janitor.invalid commit --quiet -m "Seed fixture"
git clone --quiet --bare "$work" "$target"
rm -rf "$work"
