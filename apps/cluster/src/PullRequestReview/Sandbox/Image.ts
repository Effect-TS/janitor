import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"

/**
 * What the PR review and chat sandbox containers share: the base image, and
 * trusting Cloudflare's intercept CA once the container runs.
 */

// The containers run on Node; cluster code is typed without Node globals.
declare const process: { readonly env: Record<string, string | undefined> }

/**
 * The PR review sandbox's image steps, which the chat sandbox's image
 * extends. Interpolated into each container's `Dockerfile.inline`.
 */
export const REVIEW_IMAGE = `
FROM node:26-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl g++ git make python3 ripgrep && rm -rf /var/lib/apt/lists/*
RUN git config --system core.hooksPath /dev/null
# pnpm and yarn through corepack, at the version a repository's
# packageManager pins. Downloads without asking: no one can answer.
# Node 26 fixes undici streaming through the HTTPS intercept; Node 25+
# no longer bundles corepack, so install it explicitly.
RUN npm install -g corepack@0.36.0 && corepack enable
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN mkdir -p /app /workspace
RUN cd /app && npm install --no-save --no-audit --no-fund @silvia-odwyer/photon-node@0.3.4
`

/** Cloudflare's intercept CA. It exists only once the container runs with HTTPS intercepted. */
const INTERCEPT_CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt"
const SYSTEM_BUNDLE = "/etc/ssl/certs/ca-certificates.crt"

/**
 * Trusts the intercept CA: appended to the system bundle for git, curl and
 * python, and named in `NODE_EXTRA_CA_CERTS` for node (and npm), which reads
 * its own store. Child processes inherit the environment. Idempotent, and a
 * no-op until the CA exists.
 */
export const trustInterceptCa = Effect.gen(function* () {
  if (process.env.NODE_EXTRA_CA_CERTS === INTERCEPT_CA) return
  const fs = yield* FileSystem.FileSystem
  if (!(yield* fs.exists(INTERCEPT_CA))) return
  const ca = yield* fs.readFileString(INTERCEPT_CA)
  if (!(yield* fs.readFileString(SYSTEM_BUNDLE)).includes(ca.trim())) {
    yield* fs.writeFileString(SYSTEM_BUNDLE, `\n${ca}`, { flag: "a" })
  }
  process.env.NODE_EXTRA_CA_CERTS = INTERCEPT_CA
  process.env.REQUESTS_CA_BUNDLE = SYSTEM_BUNDLE
  process.env.PIP_CERT = SYSTEM_BUNDLE
})
