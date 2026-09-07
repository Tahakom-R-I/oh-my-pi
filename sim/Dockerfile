# Simulation of the report's VM image (report §6.1/§6.4).
# Real GCP equivalent: repo-root Dockerfile / pi-base, or an MIG from this image.
FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl git ca-certificates jq tini sqlite3 ripgrep unzip \
    && rm -rf /var/lib/apt/lists/* \
    && git config --system --add safe.directory '*'

# Bun >= 1.3.14 required by @oh-my-pi/pi-coding-agent (engines field).
ENV BUN_INSTALL=/usr/local
RUN curl -fsSL https://bun.sh/install | bash

WORKDIR /app
COPY package.json server.ts ./
RUN bun install

ENV WORKSPACES_DIR=/workspaces \
    PORT=8080

VOLUME ["/state", "/workspaces"]
EXPOSE 8080

# On the real VM this process is a systemd unit (report §6.4); tini plays init here.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "server.ts"]
