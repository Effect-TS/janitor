# The local development sandbox: the production image plus a disposable Git
# remote so sessions can clone and publish without GitHub credentials.
FROM docker.io/cloudflare/sandbox:0.12.9@sha256:4a56a37a3cfd9b38d65bb4b5d0b341e6490a3a4c0226274ae4c1cca4948e85fe
RUN apt-get update \
  && apt-get install -y --no-install-recommends coreutils findutils ripgrep git util-linux ca-certificates procps \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid 1000 --shell /bin/bash janitor \
  && mkdir -p /workspace && chown janitor:janitor /workspace
COPY seed-remote.sh /opt/janitor/seed-remote.sh
RUN bash /opt/janitor/seed-remote.sh /opt/janitor/fixture.git && chown -R janitor:janitor /opt/janitor
