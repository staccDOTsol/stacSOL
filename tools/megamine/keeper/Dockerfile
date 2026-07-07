FROM oven/bun:1-slim
WORKDIR /app
COPY package.json ./
RUN bun install
COPY keeper.ts ./
EXPOSE 8080
CMD ["bun","run","keeper.ts"]
