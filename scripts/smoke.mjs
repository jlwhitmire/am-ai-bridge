// Smoke test: node scripts/smoke.mjs <url> — needs MCP_BEARER_TOKEN in env.
// Calls every read-only tool once and prints a compact summary.
// Tools may legitimately fail (e.g. Ollama unreachable, no GPU) — the point is
// to confirm the bridge is up, auth works, and tools return gracefully.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = new URL(process.argv[2] ?? "http://localhost:3102/mcp");
const transport = new StreamableHTTPClientTransport(url, {
  requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_BEARER_TOKEN}` } },
});
const client = new Client({ name: "am-ai-smoke", version: "1.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).sort().join(", "));

const calls = [
  ["list_models", {}],
  ["list_running_models", {}],
  ["get_ollama_version", {}],
  ["get_gpu_status", {}],
  ["get_system_health", {}],
  ["get_system_health", { path: "/" }],
  ["tail_app_logs", { lines: 10 }],
];
for (const [name, args] of calls) {
  try {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? "";
    console.log(`\n## ${name} ${JSON.stringify(args)} → ${r.isError ? "ERROR" : "ok"}\n${text.slice(0, 900)}`);
  } catch (e) {
    console.log(`\n## ${name} ${JSON.stringify(args)} → THROWN ${e.message.slice(0, 300)}`);
  }
}
await client.close();
