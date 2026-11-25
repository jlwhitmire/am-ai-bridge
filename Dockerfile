# syntax=docker/dockerfile:1
# AM-AI MCP bridge — Node 20 LTS. Runs read-only; see docker-compose.yml for config.
FROM node:20-alpine AS build
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build && pnpm prune --prod

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production MCP_PORT=3102
RUN addgroup -S -g 1001 mcp && adduser -S -u 1001 -G mcp mcp
COPY --from=build --chown=mcp:mcp /app/package.json ./
COPY --from=build --chown=mcp:mcp /app/node_modules ./node_modules
COPY --from=build --chown=mcp:mcp /app/dist ./dist
USER mcp
EXPOSE 3102
CMD ["node", "dist/server.js"]
