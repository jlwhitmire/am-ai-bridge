# syntax=docker/dockerfile:1
# AM-AI MCP bridge — Node 20 LTS on Debian slim (glibc).
#
# Why slim and not alpine: the NVIDIA container runtime injects the host's
# nvidia-smi + NVML driver libraries into the container at runtime so the
# get_gpu_status tool works. Those are glibc binaries and will NOT run on
# alpine (musl), so the image must be glibc-based.
FROM node:20-slim AS build
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build && pnpm prune --prod

FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production MCP_PORT=3102
# GPU visibility for the NVIDIA container runtime.
# "utility" capability provides nvidia-smi + NVML (read-only monitoring) without
# pulling in full CUDA compute — exactly what the read-only bridge needs.
ENV NVIDIA_VISIBLE_DEVICES=all NVIDIA_DRIVER_CAPABILITIES=utility
RUN groupadd -g 1001 mcp && useradd -u 1001 -g mcp -M -s /usr/sbin/nologin mcp
COPY --from=build --chown=mcp:mcp /app/package.json ./
COPY --from=build --chown=mcp:mcp /app/node_modules ./node_modules
COPY --from=build --chown=mcp:mcp /app/dist ./dist
USER mcp
EXPOSE 3102
CMD ["node", "dist/server.js"]
