# syntax=docker/dockerfile:1
FROM oven/bun:1.3.10 AS build
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

FROM caddy:2-alpine AS runtime
ARG ARTIFLOW_VERSION=dev
ARG ARTIFLOW_GIT_SHA=unknown
LABEL org.opencontainers.image.title="Artiflow web" \
  org.opencontainers.image.description="Artiflow dashboard and reverse proxy" \
  org.opencontainers.image.version="${ARTIFLOW_VERSION}" \
  org.opencontainers.image.revision="${ARTIFLOW_GIT_SHA}" \
  org.opencontainers.image.source="https://github.com/guidobuilds/artiflow" \
  org.opencontainers.image.url="https://github.com/guidobuilds/artiflow" \
  org.opencontainers.image.licenses="MIT"
COPY docker/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/dashboard/dist /srv
EXPOSE 80 443
