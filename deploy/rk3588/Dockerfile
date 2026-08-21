# n8n (fork) image for RK3588 offline kiosk deployment.
#
# Build context = repository root. Prerequisites:
#   1. `pnpm build:n8n`        -> produces ./compiled (n8n npm-style tree)
#   2. `pnpm -F n8n-nodes-blockly-code build && pnpm -F n8n-nodes-roboframe build`
#      -> produces custom-nodes/*/dist (arch-independent JS, copied as-is)
#
# Mirrors docker/images/n8n/Dockerfile from the n8n 2.35.4 snapshot: the
# builder stage exists because the runtime base has no toolchain. Digest pins
# are copied from the upstream files — bump together.
#
# NOTE: the runtime stage installs the compiled tree with `npm install -g
# /tmp/n8n` rather than COPYing it into /usr/local/lib/node_modules directly.
# `npm i -g` creates the /usr/local/bin/n8n launcher that the official
# entrypoint and CMD rely on; a plain COPY would leave `n8n` not found.

ARG NODE_VERSION=24.18.1

# Digest pins to node:24.18.1-alpine3.24 (linux/amd64 + linux/arm64).
FROM node:24.18.1-alpine3.24@sha256:f70403e87646dc51b45295f4b8b70cdad0b63d2297c4c9899119b03f7af7a6b3 AS builder
COPY ./compiled /usr/local/lib/node_modules/n8n
RUN apk add --no-cache python3 make g++ && \
    cd /usr/local/lib/node_modules/n8n && \
    npm rebuild sqlite3 && \
    # isolated-vm must be rebuilt from source on musl (see upstream Dockerfile
    # comment — node-gyp-build misdetects musl on this base).
    rm -rf node_modules/isolated-vm/prebuilds && \
    cd node_modules/isolated-vm && \
    node /usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild --release -j max

# Digest pins to n8nio/base:24.18.1 (Node 24.18.1, Alpine 3.24).
FROM n8nio/base:24.18.1@sha256:f7a23e449f093b8b203467919e969ca35d12ba959442aadc1f69bb174b160ad2

# Install the rebuilt tree in place and create the bin link manually.
# (npm i -g /tmp/n8n only symlinks to the source dir on this npm version —
# it does not copy — and the source dir is removed in the same layer.)
COPY --from=builder /usr/local/lib/node_modules/n8n /usr/local/lib/node_modules/n8n
RUN ln -sf ../lib/node_modules/n8n/bin/n8n /usr/local/bin/n8n && \
    n8n --version

# Custom nodes of this fork, prebuilt outside the image (plain JS + assets).
# N8N_CUSTOM_EXTENSIONS points at the parent dir; the loader scans it
# recursively and picks up both dist trees.
COPY ./custom-nodes/n8n-nodes-blockly-code/package.json /opt/n8n-custom-nodes/n8n-nodes-blockly-code/package.json
COPY ./custom-nodes/n8n-nodes-blockly-code/dist /opt/n8n-custom-nodes/n8n-nodes-blockly-code/dist
COPY ./custom-nodes/n8n-nodes-roboframe/package.json /opt/n8n-custom-nodes/n8n-nodes-roboframe/package.json
COPY ./custom-nodes/n8n-nodes-roboframe/dist /opt/n8n-custom-nodes/n8n-nodes-roboframe/dist

ENV N8N_CUSTOM_EXTENSIONS=/opt/n8n-custom-nodes

COPY ./deploy/rk3588/docker-entrypoint.sh /docker-entrypoint.sh
# git checkouts may lose the exec bit; enforce world-readable+exec inside the
# image (the runtime user is `node`, not root — --x alone cannot read the file).
RUN chmod 755 /docker-entrypoint.sh

WORKDIR /home/node
USER node
EXPOSE 5678
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["n8n"]
