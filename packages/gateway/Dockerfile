FROM oven/bun:1.3-alpine

# Build from the repository root: `docker build -f packages/gateway/Dockerfile .`
# The gateway runs on the router from this checkout, built here.
WORKDIR /app
ENV NODE_ENV=production

COPY package.json bun.lock bunfig.toml ./
COPY packages/router/package.json ./packages/router/
COPY packages/gateway/package.json ./packages/gateway/
RUN bun install --frozen-lockfile

COPY packages/router ./packages/router
RUN cd packages/router && bun run build

COPY packages/gateway/src ./packages/gateway/src
RUN rm -rf node_modules && bun install --frozen-lockfile --production

# Mount a config file and a volume for the database, e.g.
#   docker run -v ./dari-gateway.yaml:/config/dari-gateway.yaml -v gateway-data:/data ...
# A config mounted at /config/dari-gateway.yaml is served; without one the
# gateway serves its default router.
# DARI_GATEWAY_HOST=0.0.0.0 lets published ports reach the server; outside the container it defaults to loopback.
ENV DARI_GATEWAY_DB=/data/dari-gateway.db \
    DARI_GATEWAY_HOST=0.0.0.0 \
    PORT=8080
VOLUME /data
EXPOSE 8080

WORKDIR /app/packages/gateway
CMD ["sh", "-c", "if [ -z \"$DARI_GATEWAY_CONFIG\" ] && [ -f /config/dari-gateway.yaml ]; then export DARI_GATEWAY_CONFIG=/config/dari-gateway.yaml; fi; exec bun run start"]
