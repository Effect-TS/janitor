# The session sandbox image: Cloudflare's Sandbox runtime plus the Linux tools
# repository work needs. Repository commands run as the unprivileged `janitor`
# user; the Sandbox control server keeps running as root.
FROM docker.io/cloudflare/sandbox:0.12.9@sha256:4a56a37a3cfd9b38d65bb4b5d0b341e6490a3a4c0226274ae4c1cca4948e85fe
RUN apt-get update \
  && apt-get install -y --no-install-recommends coreutils findutils ripgrep git util-linux ca-certificates procps build-essential python3 \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid 1000 --shell /bin/bash janitor \
  && mkdir -p /workspace && chown janitor:janitor /workspace
