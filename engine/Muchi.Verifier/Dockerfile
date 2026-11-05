# C# replay verifier (POST /verify) for Cloud Run.
# Build context is engine/ (the verifier references Muchi.Engine and Muchi.Net):
#   docker build -f engine/Muchi.Verifier/Dockerfile -t muchi-verifier engine
# Run locally:
#   docker run --rm -p 8080:8080 -e VERIFIER_AUTH_SECRET=<32+ chars> muchi-verifier

# ---- build: restore with only the project files first so the restore layer is cached
FROM mcr.microsoft.com/dotnet/sdk:8.0-alpine AS build
WORKDIR /src
COPY Muchi.Engine/Muchi.Engine.csproj Muchi.Engine/
COPY Muchi.Net/Muchi.Net.csproj Muchi.Net/
COPY Muchi.Verifier/Muchi.Verifier.csproj Muchi.Verifier/
RUN dotnet restore Muchi.Verifier/Muchi.Verifier.csproj -r linux-musl-x64
COPY Muchi.Engine/ Muchi.Engine/
COPY Muchi.Net/ Muchi.Net/
COPY Muchi.Verifier/ Muchi.Verifier/
RUN dotnet publish Muchi.Verifier/Muchi.Verifier.csproj -c Release -r linux-musl-x64 --self-contained false \
      --no-restore -o /out /p:UseAppHost=false /p:DebugType=None /p:DebugSymbols=false

# ---- runtime: ASP.NET on Alpine (small), non-root, no SDK
FROM mcr.microsoft.com/dotnet/aspnet:8.0-alpine AS runtime
WORKDIR /app
COPY --from=build --chown=root:root /out/ ./
# Fail closed: the service refuses to start without VERIFIER_AUTH_SECRET (Cloud Run injects it from Secret Manager).
ENV VERIFIER_REQUIRE_AUTH=1 \
    PORT=8080 \
    DOTNET_gcServer=0 \
    DOTNET_TieredPGO=1 \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    ASPNETCORE_HTTP_PORTS=
# the aspnet images ship an unprivileged "app" user (uid 1654)
USER app
EXPOSE 8080
# Cloud Run uses its own startup/liveness probes (deploy/verifier/service.yaml); this one is for docker/compose.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1
ENTRYPOINT ["dotnet", "Muchi.Verifier.dll", "serve"]
