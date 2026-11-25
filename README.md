# AM-AI — read-only MCP bridge for the self-hosted AI server

A small [MCP](https://modelcontextprotocol.io) server that lets the Abacus agent
**observe** the self-hosted AI box (`aiserver`) — Ollama models, GPU, system
health and app logs — **without being able to change anything**. Every tool is
read-only: it cannot pull models, restart containers, or mutate any state.

It is reached by the agent **only** through an outbound Cloudflare tunnel (the
`AM-AI` tunnel). The bridge binds to `127.0.0.1` on the host, so it is never
exposed on the LAN and never serves a public web interface. Access is
token-gated with a Bearer token that fails **closed** (unset or < 32 chars → all
`/mcp` calls rejected).

## Endpoints

| Method | Path      | Auth            | Purpose                        |
|--------|-----------|-----------------|--------------------------------|
| GET    | `/health` | none            | Docker healthcheck / liveness  |
| POST   | `/mcp`    | `Bearer` token  | MCP JSON-RPC (Streamable HTTP) |

## Tools (all read-only)

| Tool | What it returns |
|------|-----------------|
| `list_models` | Installed Ollama models (name, size GB, modified date, params, quant) — `GET /api/tags` |
| `list_running_models` | Models currently loaded in memory — `GET /api/ps` |
| `get_ollama_version` | Ollama server version — `GET /api/version` |
| `get_gpu_status` | Per-GPU utilization, memory, temperature via `nvidia-smi` |
| `get_system_health` | Memory, CPU load average, uptime, disk usage of a path |
| `tail_app_logs` | Last N lines of `APP_LOG_FILE` with secrets/PII redacted |

### Notes on `get_gpu_status`

`nvidia-smi` is **not** available inside a plain container. For GPU reporting to
work the bridge container must be given the NVIDIA container runtime (e.g.
`runtime: nvidia`, or a `deploy.resources.reservations.devices` block requesting
the nvidia driver). If it is not configured, the tool fails gracefully with a
clear, non-fatal message — the rest of the bridge keeps working.

### Notes on `tail_app_logs`

Disabled unless `APP_LOG_FILE` is set. The bridge intentionally has **no Docker
socket**; to expose a log, mount it read-only into the container (see the
commented `volumes`/`APP_LOG_HOST_PATH` lines in `docker-compose.yml`).

### Notes on `get_system_health`

When running in a container, memory/uptime reflect the container's cgroup view
and `disk` reflects the container filesystem unless a host path is mounted. This
is fine for liveness/trend observation.

## Deploy on the AI server (`aiserver`)

Prerequisites: Docker + the Compose plugin, and Ollama listening on `11434`.

```bash
# 1. Get the code onto the box
git clone <your-repo-url> am-ai-bridge     # or: git pull  (if already cloned)
cd am-ai-bridge

# 2. Create .env from the template and generate a strong token
cp .env.example .env
sed -i "s/^MCP_BEARER_TOKEN=.*/MCP_BEARER_TOKEN=$(openssl rand -hex 32)/" .env
#   (optionally set OLLAMA_URL / APP_LOG_FILE / DISK_PATH in .env)

# 3. Build and start (detached)
docker compose up -d --build

# 4. Verify health (loopback only)
curl -s http://127.0.0.1:3102/health
#   → {"status":"ok","authConfigured":true}

# 5. Keep the token handy — you'll paste it into Abacus as the MCP Bearer token.
grep MCP_BEARER_TOKEN .env
```

Useful:

```bash
docker compose logs -f mcp-bridge     # follow logs
docker compose ps                     # health status
docker compose down                   # stop
docker compose up -d --build          # update after a git pull
```

### Optional: smoke-test all tools

From the box (needs Node 20+ and the repo's deps, or run inside the container):

```bash
MCP_BEARER_TOKEN=$(grep -oP '(?<=MCP_BEARER_TOKEN=).*' .env) \
  node scripts/smoke.mjs http://127.0.0.1:3102/mcp
```

## Cloudflare tunnel route (done in the Cloudflare dashboard)

The `AM-AI` tunnel is already installed and healthy on this box (it runs
`cloudflared` as a service — outbound only, no inbound ports opened). To expose
the bridge **privately to the agent**:

1. Cloudflare **Zero Trust → Networks → Tunnels → AM-AI → Routes → Add route** (Public Hostname).
2. **Subdomain/Domain:** e.g. `aibridge` on `accuratemedia.com`
   → `aibridge.accuratemedia.com`.
3. **Service:** `HTTP` → `localhost:3102`.
4. Save. Cloudflared now proxies `https://aibridge.accuratemedia.com` →
   `http://localhost:3102` over the existing outbound tunnel.

> Protect it: put the hostname behind a Cloudflare Access policy (or keep it
> unlisted) so only you/the agent reach it. The Bearer token is the primary gate;
> Access adds defense in depth.

## Add it as an MCP server in Abacus

On the Abacus side, add a new MCP server:

- **URL:** `https://aibridge.accuratemedia.com/mcp`
- **Auth:** Bearer token = the `MCP_BEARER_TOKEN` from `.env`.

The agent will then see the six read-only tools above.

## Local development

```bash
pnpm install
pnpm run build          # tsc → dist/
MCP_BEARER_TOKEN=$(openssl rand -hex 32) MCP_PORT=3102 node dist/server.js
curl -s http://127.0.0.1:3102/health
```

## Ports

`3102` is chosen to avoid colliding with the sibling bridges on the fleet
(Eyes Only Vault `3100`, Family Record Keeper `3101`).
