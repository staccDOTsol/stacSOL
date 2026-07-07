FROM oven/bun:1
WORKDIR /app
COPY server.ts index.html chain.html ./
ENV PORT=4700
EXPOSE 4700
CMD ["bun", "run", "server.ts"]
