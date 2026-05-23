import { execa } from "execa";
import type { CleanableItem, ExecuteResult, ScanResult } from "../lib/types.js";

const DEV_PORTS = [3000, 3001, 5173, 7007, 8080, 8081, 8082, 19000, 19001, 19002];

interface PortProcess {
  port: number;
  pid: number;
  command: string;
}

function parseLsofFieldOutput(output: string, port: number): PortProcess[] {
  const processes: PortProcess[] = [];
  let currentPid: number | null = null;
  let currentCommand: string | null = null;

  function flush(): void {
    if (currentPid !== null && currentCommand !== null) {
      processes.push({
        port,
        pid: currentPid,
        command: currentCommand
      });
    }
  }

  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      flush();
      const pid = Number.parseInt(line.slice(1), 10);
      currentPid = Number.isFinite(pid) ? pid : null;
      currentCommand = null;
      continue;
    }

    if (line.startsWith("c")) {
      currentCommand = line.slice(1);
    }
  }

  flush();
  return processes;
}

function makeDnsFlushItem(): CleanableItem {
  return {
    id: "network-dns-flush",
    category: "network",
    label: "DNS 캐시 flush",
    description: "dscacheutil -flushcache와 mDNSResponder HUP로 DNS 캐시를 비웁니다.",
    risk: "safe",
    reclaimableBytes: null,
    requiresSudo: true,
    execute: async ({ dryRun }): Promise<ExecuteResult> => {
      if (dryRun) {
        return {
          success: true,
          reclaimedBytes: null,
          message: "DNS 캐시 flush 실행 예정입니다."
        };
      }

      const flush = await execa("dscacheutil", ["-flushcache"], { reject: false });
      const hup = await execa("sudo", ["killall", "-HUP", "mDNSResponder"], { reject: false });
      const success = flush.exitCode === 0 && hup.exitCode === 0;

      return {
        success,
        reclaimedBytes: null,
        message: success
          ? "DNS 캐시를 flush했습니다."
          : [flush.stderr || flush.stdout, hup.stderr || hup.stdout].filter(Boolean).join("; ") ||
            "DNS 캐시 flush에 실패했습니다."
      };
    }
  };
}

async function scanPort(port: number): Promise<PortProcess[]> {
  const result = await execa("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-F", "pc"], {
    reject: false
  });

  if (result.exitCode !== 0 || !result.stdout.trim()) {
    return [];
  }

  return parseLsofFieldOutput(result.stdout, port);
}

function makePortItems(processes: PortProcess[]): CleanableItem[] {
  return processes.map((portProcess) => ({
    id: `network-port-${portProcess.port}-${portProcess.pid}`,
    category: "network" as const,
    label: `개발 포트 ${portProcess.port} 점유`,
    description: `${portProcess.command} (pid ${portProcess.pid})가 포트 ${portProcess.port}에서 LISTEN 중입니다.`,
    risk: "caution" as const,
    reclaimableBytes: null,
    requiresSudo: false,
    meta: {
      portProcess
    },
    execute: async ({ dryRun }): Promise<ExecuteResult> => {
      if (dryRun) {
        return {
          success: true,
          reclaimedBytes: null,
          message: `pid ${portProcess.pid}에 SIGTERM 전달 예정입니다.`
        };
      }

      try {
        process.kill(portProcess.pid, "SIGTERM");
        return {
          success: true,
          reclaimedBytes: null,
          message: `pid ${portProcess.pid}에 SIGTERM을 전달했습니다.`
        };
      } catch (error) {
        return {
          success: false,
          reclaimedBytes: null,
          message: error instanceof Error ? error.message : String(error)
        };
      }
    }
  }));
}

export async function scanNetwork(): Promise<ScanResult> {
  const portProcesses = (await Promise.all(DEV_PORTS.map((port) => scanPort(port)))).flat();

  return {
    category: "network",
    items: [makeDnsFlushItem(), ...makePortItems(portProcesses)],
    scannedAt: new Date()
  };
}
