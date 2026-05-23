import { execa } from "execa";
import type { CleanableItem, ExecuteResult, ScanResult } from "../lib/types.js";

interface PsProcess {
  pid: number;
  ppid: number;
  state: string;
  cpu: number;
  command: string;
}

function parsePs(output: string): PsProcess[] {
  const processes: PsProcess[] = [];
  const lines = output.split("\n").slice(1);

  for (const line of lines) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(.+)$/);
    if (!match?.[1] || !match[2] || !match[3] || !match[4] || !match[5]) {
      continue;
    }

    const pid = Number.parseInt(match[1], 10);
    const ppid = Number.parseInt(match[2], 10);
    const cpu = Number.parseFloat(match[4]);
    if (![pid, ppid, cpu].every(Number.isFinite)) {
      continue;
    }

    processes.push({
      pid,
      ppid,
      state: match[3],
      cpu,
      command: match[5]
    });
  }

  return processes;
}

function makeZombieItem(processes: PsProcess[]): CleanableItem | null {
  const zombies = processes.filter((processInfo) => processInfo.state.includes("Z"));
  if (zombies.length === 0) {
    return null;
  }

  const parentPids = [...new Set(zombies.map((processInfo) => processInfo.ppid).filter((pid) => pid > 1))];

  return {
    id: "cpu-zombie-processes",
    category: "cpu",
    label: `좀비 프로세스 ${zombies.length}개`,
    description: "좀비 프로세스의 부모 프로세스에 SIGCHLD를 전달해 reap을 유도합니다.",
    risk: "caution",
    reclaimableBytes: null,
    requiresSudo: false,
    meta: {
      zombies
    },
    execute: async ({ dryRun }): Promise<ExecuteResult> => {
      if (dryRun) {
        return {
          success: true,
          reclaimedBytes: null,
          message: `${parentPids.length}개 부모 프로세스에 SIGCHLD 전달 예정입니다.`
        };
      }

      const failures: string[] = [];
      for (const pid of parentPids) {
        try {
          process.kill(pid, "SIGCHLD");
        } catch (error) {
          failures.push(`${pid}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      return {
        success: failures.length === 0,
        reclaimedBytes: null,
        message: failures.length === 0
          ? `${parentPids.length}개 부모 프로세스에 SIGCHLD를 전달했습니다.`
          : `일부 SIGCHLD 전달에 실패했습니다: ${failures.join("; ")}`
      };
    }
  };
}

function makeHighCpuItems(processes: PsProcess[]): CleanableItem[] {
  return processes
    .filter((processInfo) => processInfo.cpu >= 50 && processInfo.pid !== process.pid)
    .sort((a, b) => b.cpu - a.cpu)
    .slice(0, 5)
    .map((processInfo) => ({
      id: `cpu-high-${processInfo.pid}`,
      category: "cpu" as const,
      label: `CPU ${processInfo.cpu.toFixed(1)}% 점유 프로세스`,
      description: `${processInfo.command} (pid ${processInfo.pid})를 종료합니다.`,
      risk: "danger" as const,
      reclaimableBytes: null,
      requiresSudo: false,
      meta: {
        process: processInfo
      },
      execute: async ({ dryRun }): Promise<ExecuteResult> => {
        if (dryRun) {
          return {
            success: true,
            reclaimedBytes: null,
            message: `pid ${processInfo.pid}에 SIGTERM 전달 예정입니다.`
          };
        }

        try {
          process.kill(processInfo.pid, "SIGTERM");
          return {
            success: true,
            reclaimedBytes: null,
            message: `pid ${processInfo.pid}에 SIGTERM을 전달했습니다.`
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

export async function scanCpu(): Promise<ScanResult> {
  const { stdout } = await execa("ps", ["-e", "-o", "pid,ppid,state,%cpu,command", "-r"], {
    reject: false
  });
  const processes = parsePs(stdout);
  const zombieItem = makeZombieItem(processes);
  const highCpuItems = makeHighCpuItems(processes);

  return {
    category: "cpu",
    items: [zombieItem, ...highCpuItems].filter((item): item is CleanableItem => item !== null),
    scannedAt: new Date()
  };
}
