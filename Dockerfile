FROM node:24-bookworm-slim AS base
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
USER node
CMD ["node", "src/gateway.js"]

FROM base AS worker
USER root
ARG CODEX_VERSION=latest
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @openai/codex@${CODEX_VERSION} \
    && npm cache clean --force \
    && mkdir -p /codex /workspace && chown node:node /codex /workspace
ENV CODEX_HOME=/codex
USER node
CMD ["node", "src/worker.js"]
