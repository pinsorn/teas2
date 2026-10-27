# TEAS 2 backend: one build stage, two images. Build context = the repo root (Coolify base directory "/", compose `context: ..`).
#   docker build -f deploy/backend/Dockerfile --target api      -t teas-api .
#   docker build -f deploy/backend/Dockerfile --target migrator -t teas-migrator .
# No secret is baked in: the connection strings, TEAS_BFF_SECRET etc. arrive as environment variables (see deploy/README.md). Docker is not available on
# the dev box, so this file is only ever built by CI (the `compose` job of .github/workflows/backend.yml) and by Coolify.
# Tags are major.minor (the patch rolls with the base image); backend/global.json allows rollForward latestFeature.
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY backend/ backend/
# The Api build also emits backend/artifacts/openapi.json (Microsoft.Extensions.ApiDescription.Server), inside the container only.
RUN dotnet publish backend/src/Teas.Api -c Release -o /out/api \
 && dotnet publish backend/src/Teas.Migrator -c Release -o /out/migrator

# Both runtime targets run as the image's built-in non-root user ($APP_UID); the data directories are created owned by it so that a NEW named volume
# mounted there is writable (an existing volume or a bind mount keeps its own ownership: chown it to $APP_UID once).
FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS migrator
WORKDIR /app
COPY --from=build /out/migrator ./
USER $APP_UID
ENTRYPOINT ["dotnet", "Teas.Migrator.dll"]

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS api
WORKDIR /app
RUN mkdir -p /data/files /data/dp-keys && chown $APP_UID /data/files /data/dp-keys
COPY --from=build /out/api ./
ENV ASPNETCORE_URLS=http://+:8080 TEAS_FILES_DIR=/data/files TEAS_DP_KEYS_DIR=/data/dp-keys
EXPOSE 8080
USER $APP_UID
ENTRYPOINT ["dotnet", "Teas.Api.dll"]
