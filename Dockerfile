# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install --yes --no-install-recommends chromium ca-certificates fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
ENV NODE_ENV=production \
  CRAWLUME_DATA_DIR=/data \
  CRAWLUME_BROWSER_EXECUTABLE=/usr/bin/chromium
RUN mkdir /data && chown node:node /data
USER node
VOLUME ["/data"]
# MCP over stdio by default; pass --control-plane to run the control-plane HTTP API.
ENTRYPOINT ["node", "--disable-warning=ExperimentalWarning", "dist/server.js"]
