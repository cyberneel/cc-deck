# cc-deck in a container. The whole point: cc-deck needs Linux + tmux + node-pty,
# which is awkward on Windows/macOS — but Docker Desktop runs a Linux VM, so this
# image runs the same everywhere. It bundles the Claude Code and Codex CLIs so a
# session launches inside the container against your mounted project dir.

# ---- build: compile node-pty + bundle the client ----
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime ----
FROM node:24-bookworm-slim
# tmux runs the sessions; git for branch detection; the CLIs cc-deck manages.
RUN apt-get update && apt-get install -y --no-install-recommends tmux git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code @openai/codex \
    && npm cache clean --force
# Run as the image's built-in non-root `node` user (uid 1000, home /home/node).
# cc-deck writes ~/.claude (transcripts, notes, restore) and the CLIs write their
# auth there, so keep /home/node on a volume.
WORKDIR /app
COPY --from=build --chown=node:node /app /app
COPY --chown=node:node docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
USER node
# Bind 0.0.0.0 INSIDE the container; restrict exposure with the host port mapping
# (e.g. `-p 127.0.0.1:8787:8787`). Roots default to the mounted /workspace.
ENV HOME=/home/node \
    NODE_ENV=production \
    CCDECK_BIND=0.0.0.0 \
    CCDECK_ROOTS=/workspace
EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
