FROM node:24-bookworm-slim AS base
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
RUN mkdir /channels && chown node:node /channels
COPY src ./src
USER node
CMD ["node", "src/gateway.js"]

FROM base AS worker
USER root
ARG CODEX_VERSION=0.158.0
ARG CLAUDE_VERSION=2.1.284
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @openai/codex@${CODEX_VERSION} \
    && npm install -g @anthropic-ai/claude-code@${CLAUDE_VERSION} \
    && npm cache clean --force \
    && mkdir -p /codex /claude /workspace && chown node:node /codex /claude /workspace
ENV CODEX_HOME=/codex
ENV CLAUDE_CONFIG_DIR=/claude
ENV CODEX_CLI_VERSION=${CODEX_VERSION}
ENV CLAUDE_CLI_VERSION=${CLAUDE_VERSION}
USER node
CMD ["node", "src/worker.js"]
