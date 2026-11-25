import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BYTES_PER_GB, fail, ok, round, safe } from "../result.js";

/**
 * Ollama observation tools (read-only).
 *
 * The bridge runs in a container while Ollama listens on the host. OLLAMA_URL
 * defaults to http://host.docker.internal:11434 — the docker-compose file maps
 * host.docker.internal:host-gateway so the container can reach the host. Set
 * OLLAMA_URL in .env to override (e.g. http://<host-ip>:11434).
 */
const OLLAMA_URL = (process.env.OLLAMA_URL ?? "http://host.docker.internal:11434").replace(/\/+$/, "");
const FETCH_TIMEOUT_MS = 8000;

async function ollamaGet(path: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${OLLAMA_URL}${path}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`Ollama responded ${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function describeFetchError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof Error && err.name === "AbortError") {
    return `Ollama did not respond within ${FETCH_TIMEOUT_MS}ms at ${OLLAMA_URL}`;
  }
  return `cannot reach Ollama at ${OLLAMA_URL} (${msg}). Check OLLAMA_URL and that the container can reach the host (host.docker.internal:host-gateway).`;
}

interface OllamaModel {
  name?: string;
  model?: string;
  size?: number;
  modified_at?: string;
  expires_at?: string;
  size_vram?: number;
  details?: { parameter_size?: string; quantization_level?: string; family?: string };
}

export function registerModelTools(server: McpServer): void {
  server.registerTool(
    "list_models",
    {
      title: "List installed Ollama models",
      description:
        "Installed Ollama models (GET /api/tags): name, size (GB), modified date, parameter size and quantization. Read-only.",
      inputSchema: {},
    },
    safe("list_models", async () => {
      let data: { models?: OllamaModel[] };
      try {
        data = (await ollamaGet("/api/tags")) as { models?: OllamaModel[] };
      } catch (err) {
        return fail(`list_models: ${describeFetchError(err)}`);
      }
      const models = (data.models ?? []).map((m) => ({
        name: m.name ?? m.model ?? "unknown",
        size_gb: typeof m.size === "number" ? round(m.size / BYTES_PER_GB, 2) : null,
        modified_at: m.modified_at ?? null,
        parameter_size: m.details?.parameter_size ?? null,
        quantization: m.details?.quantization_level ?? null,
        family: m.details?.family ?? null,
      }));
      return ok({ ollama_url: OLLAMA_URL, count: models.length, models });
    }),
  );

  server.registerTool(
    "list_running_models",
    {
      title: "List running Ollama models",
      description:
        "Models currently loaded in memory (GET /api/ps): name, VRAM/size usage (GB), and expiry. Empty list means nothing is loaded. Read-only.",
      inputSchema: {},
    },
    safe("list_running_models", async () => {
      let data: { models?: OllamaModel[] };
      try {
        data = (await ollamaGet("/api/ps")) as { models?: OllamaModel[] };
      } catch (err) {
        return fail(`list_running_models: ${describeFetchError(err)}`);
      }
      const models = (data.models ?? []).map((m) => ({
        name: m.name ?? m.model ?? "unknown",
        size_gb: typeof m.size === "number" ? round(m.size / BYTES_PER_GB, 2) : null,
        size_vram_gb: typeof m.size_vram === "number" ? round(m.size_vram / BYTES_PER_GB, 2) : null,
        expires_at: m.expires_at ?? null,
      }));
      return ok({ ollama_url: OLLAMA_URL, count: models.length, running: models });
    }),
  );

  server.registerTool(
    "get_ollama_version",
    {
      title: "Get Ollama version",
      description: "Ollama server version (GET /api/version). Read-only.",
      inputSchema: {},
    },
    safe("get_ollama_version", async () => {
      let data: { version?: string };
      try {
        data = (await ollamaGet("/api/version")) as { version?: string };
      } catch (err) {
        return fail(`get_ollama_version: ${describeFetchError(err)}`);
      }
      return ok({ ollama_url: OLLAMA_URL, version: data.version ?? "unknown" });
    }),
  );
}
