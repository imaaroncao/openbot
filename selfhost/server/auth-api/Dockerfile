# Self-hosted fork: the account service, run by workerd through `wrangler dev --local`.
# The Worker is built on the developer's computer (selfhost/server/scripts/package-auth-api.sh);
# this image only runs it. D1 (SQLite) and R2 (files) live in the /data volume.
FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates curl tini \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY selfhost/server/auth-api/bundle/wrangler-version /app/wrangler-version
RUN npm install --global --no-fund --no-audit "wrangler@$(cat /app/wrangler-version)" \
  && wrangler --version
COPY selfhost/server/auth-api/bundle /app/bundle
COPY selfhost/server/auth-api/entrypoint.sh /app/entrypoint.sh
RUN chmod 0755 /app/entrypoint.sh && mkdir -p /data && chown -R node:node /app /data
USER node
ENV WRANGLER_SEND_METRICS=false \
  WRANGLER_LOG_PATH=/tmp/wrangler-logs \
  XDG_CONFIG_HOME=/tmp/xdg \
  HOME=/tmp
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --retries=5 --start-period=60s \
  CMD curl -fsS http://127.0.0.1:8787/health/live >/dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
