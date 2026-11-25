import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, round, safe } from "../result.js";

const execFileAsync = promisify(execFile);
const BYTES_PER_GB = 1024 ** 3;

/**
 * System health observation (read-only).
 *
 * Memory, load average and uptime come from Node's os module. Disk usage comes
 * from `df` for a configurable path (default "/", override via DISK_PATH env or
 * the `path` argument). All read-only; nothing is mutated.
 */
interface DiskUsage {
  path: string;
  filesystem: string | null;
  size_gb: number | null;
  used_gb: number | null;
  available_gb: number | null;
  use_pct: number | null;
}

async function diskUsage(path: string): Promise<DiskUsage> {
  // df -k -P <path>  → POSIX output in 1K blocks (portable, stable columns).
  const { stdout } = await execFileAsync("df", ["-k", "-P", path], { timeout: 5000 });
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const row = lines[lines.length - 1] ?? "";
  const cols = row.trim().split(/\s+/);
  // Filesystem  1024-blocks  Used  Available  Capacity  Mounted on
  const toGb = (kb: string | undefined) => {
    const n = Number(kb);
    return Number.isFinite(n) ? round((n * 1024) / BYTES_PER_GB, 2) : null;
  };
  const pct = cols[4]?.replace("%", "");
  return {
    path,
    filesystem: cols[0] ?? null,
    size_gb: toGb(cols[1]),
    used_gb: toGb(cols[2]),
    available_gb: toGb(cols[3]),
    use_pct: pct !== undefined && Number.isFinite(Number(pct)) ? Number(pct) : null,
  };
}

export function registerSystemTools(server: McpServer): void {
  server.registerTool(
    "get_system_health",
    {
      title: "Get system health",
      description:
        "Host memory (GB), CPU load average, uptime and disk usage for a path (default DISK_PATH or '/'). Read-only.",
      inputSchema: { path: z.string().min(1).optional() },
    },
    safe("get_system_health", async ({ path }: { path?: string }) => {
      const diskPath = path ?? process.env.DISK_PATH ?? "/";
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const [load1 = 0, load5 = 0, load15 = 0] = os.loadavg();

      let disk: DiskUsage | { path: string; error: string };
      try {
        disk = await diskUsage(diskPath);
      } catch (err) {
        disk = { path: diskPath, error: `df failed: ${err instanceof Error ? err.message : String(err)}` };
      }

      return ok({
        hostname: os.hostname(),
        platform: `${os.type()} ${os.release()}`,
        cpu_count: os.cpus().length,
        load_average: { "1m": round(load1, 2), "5m": round(load5, 2), "15m": round(load15, 2) },
        memory: {
          total_gb: round(totalMem / BYTES_PER_GB, 2),
          used_gb: round(usedMem / BYTES_PER_GB, 2),
          free_gb: round(freeMem / BYTES_PER_GB, 2),
          used_pct: round((usedMem / totalMem) * 100, 1),
        },
        uptime_hours: round(os.uptime() / 3600, 2),
        disk,
      });
    }),
  );
}
