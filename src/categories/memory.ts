import { execa } from "execa";
import { parseVmStat } from "../lib/doctor.js";
import type { CleanableItem, ExecuteResult, ScanResult } from "../lib/types.js";

interface ProcessInfo {
  pid: number;
  commandName: string;
  command: string;
}

async function commandExists(command: string): Promise<boolean> {
  const result = await execa("which", [command], { reject: false });
  return result.exitCode === 0;
}

function bytesFromPages(pageSizeBytes: number | null, pages: number | undefined): number | null {
  if (pageSizeBytes === null || pages === undefined) {
    return null;
  }

  return pageSizeBytes * pages;
}

async function scanInactiveMemory(): Promise<CleanableItem | null> {
  if (!(await commandExists("purge"))) {
    return null;
  }

  const { stdout } = await execa("vm_stat", [], { reject: false });
  const snapshot = parseVmStat(stdout);
  const inactiveBytes = bytesFromPages(snapshot.pageSizeBytes, snapshot.pages["Pages inactive"]);

  if (inactiveBytes === null || inactiveBytes <= 0) {
    return null;
  }

  return {
    id: "memory-purge-inactive",
    category: "memory",
    label: "비활성 메모리 purge",
    description: "vm_stat 기준 비활성 메모리를 sudo purge로 회수합니다.",
    risk: "safe",
    reclaimableBytes: inactiveBytes,
    requiresSudo: true,
    meta: {
      pageSizeBytes: snapshot.pageSizeBytes,
      inactivePages: snapshot.pages["Pages inactive"] ?? null
    },
    execute: async ({ dryRun }): Promise<ExecuteResult> => {
      if (dryRun) {
        return {
          success: true,
          reclaimedBytes: inactiveBytes,
          message: "sudo purge 실행 예정입니다."
        };
      }

      const result = await execa("sudo", ["purge"], { reject: false });
      return {
        success: result.exitCode === 0,
        reclaimedBytes: result.exitCode === 0 ? inactiveBytes : null,
        message: result.exitCode === 0
          ? "비활성 메모리 purge를 실행했습니다."
          : (result.stderr || result.stdout || "sudo purge 실행에 실패했습니다.")
      };
    }
  };
}

function parseProcesses(output: string): ProcessInfo[] {
  const processes: ProcessInfo[] = [];

  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\S+)\s+(.+)$/);
    if (!match?.[1] || !match[2] || !match[3]) {
      continue;
    }

    const pid = Number.parseInt(match[1], 10);
    if (!Number.isFinite(pid) || pid === process.pid) {
      continue;
    }

    processes.push({
      pid,
      commandName: match[2],
      command: match[3]
    });
  }

  return processes;
}

function isReactNativeResidualProcess(processInfo: ProcessInfo): boolean {
  const command = processInfo.command.toLowerCase();
  const commandName = processInfo.commandName.toLowerCase();
  const executableName = commandName.split("/").at(-1) ?? commandName;

  const isMetro =
    command.includes("metro") ||
    (command.includes("react-native") && command.includes("start"));
  const isWatchman = commandName.includes("watchman") || command.includes("/watchman");
  const isSimulator = executableName === "simulator" || command.includes("simulator.app/");
  const isQemu = executableName.includes("qemu") || command.includes("qemu-system");

  return isMetro || isWatchman || isSimulator || isQemu;
}

function processDisplayName(processInfo: ProcessInfo): string {
  const command = processInfo.command.toLowerCase();
  const commandName = processInfo.commandName.toLowerCase();

  if (command.includes("simulator.app/") || commandName.endsWith("/simulator")) {
    return "Simulator";
  }

  if (commandName.includes("watchman") || command.includes("/watchman")) {
    return "watchman";
  }

  if (command.includes("qemu-system")) {
    return "qemu";
  }

  if (command.includes("metro")) {
    return "Metro";
  }

  const executable = processInfo.command.split(/\s+/).at(0) ?? processInfo.commandName;
  return executable.split("/").at(-1) ?? processInfo.commandName;
}

async function scanResidualProcesses(): Promise<CleanableItem | null> {
  const { stdout } = await execa("ps", ["-axo", "pid=,comm=,command="], { reject: false });
  const matches = parseProcesses(stdout).filter(isReactNativeResidualProcess);

  if (matches.length === 0) {
    return null;
  }

  const pids = matches.map((processInfo) => processInfo.pid);
  const commandSummary = matches
    .slice(0, 5)
    .map((processInfo) => `${processInfo.pid}:${processDisplayName(processInfo)}`)
    .join(", ");

  return {
    id: "memory-rn-residual-processes",
    category: "memory",
    label: `React Native 개발 잔존 프로세스 ${matches.length}개`,
    description: `Metro, Watchman, Simulator, qemu 계열 프로세스를 종료합니다. (${commandSummary})`,
    risk: "caution",
    reclaimableBytes: null,
    requiresSudo: false,
    meta: {
      processes: matches
    },
    execute: async ({ dryRun }): Promise<ExecuteResult> => {
      if (dryRun) {
        return {
          success: true,
          reclaimedBytes: null,
          message: `${pids.length}개 프로세스에 SIGTERM 전달 예정입니다.`
        };
      }

      const failures: string[] = [];
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGTERM");
        } catch (error) {
          failures.push(`${pid}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      return {
        success: failures.length === 0,
        reclaimedBytes: null,
        message: failures.length === 0
          ? `${pids.length}개 프로세스에 SIGTERM을 전달했습니다.`
          : `일부 프로세스 종료에 실패했습니다: ${failures.join("; ")}`
      };
    }
  };
}

export async function scanMemory(): Promise<ScanResult> {
  const items = (await Promise.all([scanInactiveMemory(), scanResidualProcesses()])).filter(
    (item): item is CleanableItem => item !== null
  );

  return {
    category: "memory",
    items,
    scannedAt: new Date()
  };
}
