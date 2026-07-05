# token-watch relay + built aggr terminal, one container.
# Build context: tools/ (run `fly deploy` from this directory).
# NOTE: build tools/ansem-aggr first (bun run build) — dist is COPY'd, not built here.
FROM oven/bun:1-slim

WORKDIR /app

COPY ansem-watch/package.json ansem-watch/bun.lock* ./ansem-watch/
RUN cd ansem-watch && bun install --production

COPY ansem-watch/server.ts ansem-watch/subs.ts ansem-watch/subs-server.ts ansem-watch/subs-stream.ts ansem-watch/burn.ts ansem-watch/paywall.js ansem-watch/index.html ./ansem-watch/
COPY ansem-aggr/dist ./ansem-aggr/dist

ENV DATA_DIR=/data
RUN mkdir -p /data

EXPOSE 4477
# relay + billing sidecar in one container
CMD ["sh", "-c", "bun run /app/ansem-watch/subs-server.ts & exec bun run /app/ansem-watch/server.ts"]
