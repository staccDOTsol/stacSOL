# token-watch relay + built aggr terminal, one container.
# Build context: tools/ (run `fly deploy` from this directory).
# NOTE: build tools/ansem-aggr first (bun run build) — dist is COPY'd, not built here.
FROM oven/bun:1-slim

WORKDIR /app

COPY ansem-watch/server.ts ansem-watch/index.html ./ansem-watch/
COPY ansem-aggr/dist ./ansem-aggr/dist

ENV DATA_DIR=/data
RUN mkdir -p /data

EXPOSE 4477
CMD ["bun", "run", "/app/ansem-watch/server.ts"]
