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
ENV NEXT_PUBLIC_API_MOCKING=enabled
RUN pnpm build

FROM node:24-alpine AS run
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
