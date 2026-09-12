FROM docker.io/cloudflare/sandbox:0.12.9@sha256:4a56a37a3cfd9b38d65bb4b5d0b341e6490a3a4c0226274ae4c1cca4948e85fe
RUN apt-get update && apt-get install -y --no-install-recommends coreutils findutils ripgrep git util-linux ca-certificates && rm -rf /var/lib/apt/lists/*
COPY server.mjs entry.mjs /opt/janitor/
RUN node --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; new DatabaseSync(":memory:")'
