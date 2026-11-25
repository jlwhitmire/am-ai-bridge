/**
 * AM-AI — read-only MCP bridge for the self-hosted AI server (Streamable HTTP, stateless).
 *
 *   GET  /health  → 200 {status:"ok"}           (no auth; Docker healthcheck)
 *   POST /mcp     → MCP JSON-RPC                (Bearer MCP_BEARER_TOKEN)
 *
 * Observe-only bridge for the AI runtime: Ollama models, GPU, system health and
 * app logs. Every tool is read-only — it cannot pull models, restart containers
 * or mutate anything. Reached by the agent through an outbound Cloudflare tunnel;
 * no public web interface is exposed.
 * Tools: list_models, list_running_models, get_ollama_version, get_gpu_status,
 * get_system_health, tail_app_logs.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isTokenConfigured, verifyBearer } from "./auth.js";
import { registerModelTools } from "./tools/models.js";
import { registerGpuTools } from "./tools/gpu.js";
import { registerSystemTools } from "./tools/system.js";
import { registerLogTools } from "./tools/logs.js";

const PORT = Number(process.env.MCP_PORT ?? 3102);
const MAX_BODY_BYTES = 1024 * 1024;

export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "am-ai-mcp-bridge", version: "0.1.0" });
  registerModelTools(server);
  registerGpuTools(server);
  registerSystemTools(server);
  registerLogTools(server);
  return server;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("Payload too large");
    chunks.push(chunk as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    sendJson(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
    return;
  }
  // Stateless mode: fresh server + transport per request.
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, await readJson(req));
}

const httpServer = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/health") {
    sendJson(res, 200, { status: "ok", authConfigured: isTokenConfigured() });
    return;
  }

  if (url.pathname === "/mcp") {
    if (!verifyBearer(req)) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="am-ai-mcp"');
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    handleMcp(req, res).catch((err: unknown) => {
      console.error("[mcp] request failed:", err);
      if (!res.headersSent) sendJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    });
    return;
  }

  sendJson(res, 404, { error: "not_found" });
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[mcp-bridge] listening on :${PORT}${isTokenConfigured() ? "" : " — WARNING: MCP_BEARER_TOKEN unset/short, all /mcp calls will be rejected"}`);
});

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => httpServer.close(() => process.exit(0)));
}
