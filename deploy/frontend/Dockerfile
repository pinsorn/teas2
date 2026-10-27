# Build context = repo root (Coolify base directory "/"). Serves the mock-backed frontend (MSW in the browser).
FROM node:24-alpine AS deps
WORKDIR /app
RUN corepack enable
# pnpm-workspace.yaml carries ignoredBuiltDependencies; the pnpm version comes from package.json "packageManager".
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY frontend/ .
# The mockup preview is the default (mock worker only). The CI compose stack builds the hybrid variant: --build-arg NEXT_PUBLIC_API_MODE=hybrid
ARG NEXT_PUBLIC_API_MOCKING=enabled
ARG NEXT_PUBLIC_API_MODE=mock
ENV NEXT_PUBLIC_API_MOCKING=$NEXT_PUBLIC_API_MOCKING NEXT_PUBLIC_API_MODE=$NEXT_PUBLIC_API_MODE
# src/contract/generated/openapi.ts is git-ignored and the conformance check imports it: generate it from the committed document first
# (gen:api reads ../docs/api/openapi.v1.json, i.e. /docs/api/ from WORKDIR /app).
COPY docs/api/openapi.v1.json /docs/api/openapi.v1.json
RUN pnpm gen:api && pnpm build

FROM node:24-alpine AS run
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
