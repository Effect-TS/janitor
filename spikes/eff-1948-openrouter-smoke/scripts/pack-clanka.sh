#!/usr/bin/env bash
# Builds clanka at the commit the harness ran on and packs it into vendor/.
# clanka's git dependency form would not build `dist`, hence the tarball.
set -euo pipefail
COMMIT="${1:-9d0da00532d91d471102d13f6191a7978992914e}"
DIR="$(mktemp -d)"
git clone -q https://github.com/Effectful-Tech/clanka.git "$DIR"
git -C "$DIR" checkout -q "$COMMIT"
(cd "$DIR" && nix develop -c pnpm install --frozen-lockfile && nix develop -c pnpm build)
mkdir -p "$(dirname "$0")/../vendor"
(cd "$DIR" && nix develop -c pnpm pack --out "$(cd "$(dirname "$0")/.." && pwd)/vendor/clanka-0.8.6-${COMMIT:0:7}.tgz")
rm -rf "$DIR"
