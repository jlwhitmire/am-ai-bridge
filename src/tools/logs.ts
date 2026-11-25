import { open, stat } from "node:fs/promises";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fail, ok, safe } from "../result.js";

const MAX_TAIL_BYTES = 1024 * 1024;

/** Best-effort scrubbing of secrets/PII that might appear in log lines. */
export function redact(line: string): string {
  return line
    .replace(/(authorization:\s*)(bearer|basic)\s+\S+/gi, "$1$2 [REDACTED]")
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, "$1 [REDACTED]")
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[EMAIL]")
    .replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/gi, "$1[REDACTED]@")
    .replace(/\b(password|secret|token|api[_-]?key)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1$2[REDACTED]");
}

/** Read the last `lines` lines of a file, scanning at most the final 1 MiB. */
export async function tailFile(path: string, lines: number): Promise<string[]> {
  const { size } = await stat(path);
  const start = Math.max(0, size - MAX_TAIL_BYTES);
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const all = buf.toString("utf8").split(/\r?\n/);
    if (start > 0) all.shift(); // drop the partial first line
    while (all.length && all[all.length - 1] === "") all.pop();
    return all.slice(-lines);
  } finally {
    await fh.close();
  }
}

/**
 * tail_app_logs — last N lines of the app log. The bridge has NO Docker socket
 * (by design), so this reads APP_LOG_FILE: a file the app's log shipper writes
 * to a read-only volume shared with this container. Unset → clear error.
 */
export function registerLogTools(server: McpServer): void {
  server.registerTool(
    "tail_app_logs",
    {
      title: "Tail app logs",
      description:
        "Last N lines (max 500) of the app container log, with tokens/emails/passwords redacted. Requires APP_LOG_FILE to be mounted read-only into the bridge. Read-only.",
      inputSchema: { lines: z.number().int().min(1).max(500).default(100) },
    },
    safe("tail_app_logs", async ({ lines }: { lines: number }) => {
      const path = process.env.APP_LOG_FILE;
      if (!path) {
        return fail(
          "tail_app_logs: not configured — set APP_LOG_FILE and mount the app log read-only into mcp-bridge. The bridge intentionally has no Docker socket access.",
        );
      }
      try {
        const out = (await tailFile(path, lines)).map(redact);
        return ok({ file: path, lines: out.length, log: out });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return fail(`tail_app_logs: log file not found (${path})`);
        throw err;
      }
    }),
  );
}
