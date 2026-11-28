# syntax=docker/dockerfile:1
FROM oven/bun:1.3.10 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/dashboard/package.json ./apps/dashboard/
COPY apps/web/package.json ./apps/web/
COPY plugins/opencode/package.json ./plugins/opencode/
COPY packages ./packages
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.10 AS dashboard
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/dashboard/package.json ./apps/dashboard/
COPY apps/web/package.json ./apps/web/
COPY plugins/opencode/package.json ./plugins/opencode/
COPY packages ./packages
RUN bun install --frozen-lockfile
COPY tsconfig.json tsconfig.base.json ./
COPY brand ./brand
COPY apps/dashboard ./apps/dashboard
RUN bun run --filter '@artiflow/dashboard' build

FROM oven/bun:1.3.10 AS runtime
ARG ARTIFLOW_VERSION=dev
ARG ARTIFLOW_GIT_SHA=unknown
LABEL org.opencontainers.image.title="Artiflow API" \
  org.opencontainers.image.description="Artiflow API and MCP endpoint" \
  org.opencontainers.image.version="${ARTIFLOW_VERSION}" \
  org.opencontainers.image.revision="${ARTIFLOW_GIT_SHA}" \
  org.opencontainers.image.source="https://github.com/guidobuilds/artiflow" \
  org.opencontainers.image.url="https://github.com/guidobuilds/artiflow" \
  org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
  ARTIFLOW_BUILD_VERSION="${ARTIFLOW_VERSION}" \
  ARTIFLOW_BUILD_REVISION="${ARTIFLOW_GIT_SHA}"
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY drizzle ./drizzle
COPY --from=dashboard /app/apps/dashboard/dist/.vite/manifest.json ./apps/dashboard/dist/.vite/manifest.json
USER bun
EXPOSE 8787
CMD ["bun", "apps/api/src/server.ts"]
