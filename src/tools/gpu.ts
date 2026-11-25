import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fail, ok, safe } from "../result.js";

const execFileAsync = promisify(execFile);

/**
 * GPU observation (read-only).
 *
 * Runs `nvidia-smi` to report per-GPU utilization, memory and temperature.
 *
 * NOTE: inside a plain container nvidia-smi is NOT available unless the
 * container is given the NVIDIA container runtime (deploy.resources with the
 * nvidia driver, or `runtime: nvidia`). This bridge is deliberately minimal and
 * does not require GPU access to run, so if nvidia-smi is missing this tool
 * fails gracefully (non-fatal) with an explicit message rather than crashing.
 */
const NVIDIA_SMI = process.env.NVIDIA_SMI_PATH ?? "nvidia-smi";
const QUERY = "index,name,utilization.gpu,memory.used,memory.total,temperature.gpu";

interface GpuRow {
  index: number;
  name: string;
  utilization_gpu_pct: number | null;
  memory_used_mib: number | null;
  memory_total_mib: number | null;
  temperature_c: number | null;
}

function toNum(s: string | undefined): number | null {
  if (s === undefined) return null;
  const t = s.trim();
  if (t === "" || t === "[N/A]" || t.toLowerCase() === "n/a") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function registerGpuTools(server: McpServer): void {
  server.registerTool(
    "get_gpu_status",
    {
      title: "Get GPU status",
      description:
        "Per-GPU utilization, memory (MiB) and temperature from nvidia-smi. Requires the NVIDIA container runtime / nvidia-smi inside the bridge container; if unavailable it returns a clear non-fatal error. Read-only.",
      inputSchema: {},
    },
    safe("get_gpu_status", async () => {
      let stdout: string;
      try {
        const r = await execFileAsync(
          NVIDIA_SMI,
          [`--query-gpu=${QUERY}`, "--format=csv,noheader,nounits"],
          { timeout: 8000 },
        );
        stdout = r.stdout;
      } catch (err) {
        const e = err as NodeJS.ErrnoException & { stderr?: string };
        if (e.code === "ENOENT") {
          return fail(
            "get_gpu_status: nvidia-smi not found in the bridge container. To enable GPU reporting, give this container the NVIDIA container runtime (e.g. deploy.resources.reservations.devices with the nvidia driver, or runtime: nvidia) so nvidia-smi is available. This is optional and non-fatal.",
          );
        }
        return fail(`get_gpu_status: nvidia-smi failed${e.stderr ? ` (${e.stderr.trim().slice(0, 200)})` : ""}.`);
      }

      const gpus: GpuRow[] = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .map((line) => {
          const [index, name, util, memUsed, memTotal, temp] = line.split(",").map((c) => c.trim());
          return {
            index: toNum(index) ?? -1,
            name: name ?? "unknown",
            utilization_gpu_pct: toNum(util),
            memory_used_mib: toNum(memUsed),
            memory_total_mib: toNum(memTotal),
            temperature_c: toNum(temp),
          };
        });

      return ok({ count: gpus.length, gpus });
    }),
  );
}
