import { cpus, loadavg } from "node:os";
import { execa } from "execa";
import type { DiskDiagnosis, DoctorDiagnosis, MemoryDiagnosis } from "./types.js";

interface VmStatSnapshot {
  pageSizeBytes: number | null;
  pages: Record<string, number>;
}

function parseFirstNumber(input: string): number | null {
  const match = input.match(/(\d+)/);
  if (!match?.[1]) {
    return null;
  }

  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : null;
}

export function parseVmStat(output: string): VmStatSnapshot {
  const pageSizeMatch = output.match(/page size of (\d+) bytes/i);
  const pageSizeBytes = pageSizeMatch?.[1] ? Number.parseInt(pageSizeMatch[1], 10) : null;
  const pages: Record<string, number> = {};

  for (const line of output.split("\n")) {
    const match = line.match(/^([^:]+):\s+([\d.]+)/);
    if (!match?.[1] || !match[2]) {
      continue;
    }

    pages[match[1].trim()] = Number.parseInt(match[2].replace(/\./g, ""), 10);
  }

  return {
    pageSizeBytes: Number.isFinite(pageSizeBytes) ? pageSizeBytes : null,
    pages
  };
}

function pageBytes(snapshot: VmStatSnapshot, key: string): number | null {
  const pages = snapshot.pages[key];
  if (snapshot.pageSizeBytes === null || pages === undefined) {
    return null;
  }

  return pages * snapshot.pageSizeBytes;
}

async function getTotalMemoryBytes(): Promise<number | null> {
  const { stdout } = await execa("sysctl", ["-n", "hw.memsize"], { reject: false });
  const value = Number.parseInt(stdout.trim(), 10);
  return Number.isFinite(value) ? value : null;
}

async function getMemoryPressure(): Promise<string | null> {
  const { stdout, stderr } = await execa("memory_pressure", [], { reject: false });
  return (stdout || stderr).trim() || null;
}

async function diagnoseMemory(): Promise<MemoryDiagnosis> {
  const [totalBytes, vmStatResult, pressure] = await Promise.all([
    getTotalMemoryBytes(),
    execa("vm_stat", [], { reject: false }),
    getMemoryPressure()
  ]);
  const snapshot = parseVmStat(vmStatResult.stdout);
  const activeBytes = pageBytes(snapshot, "Pages active");
  const wiredBytes = pageBytes(snapshot, "Pages wired down");
  const compressedBytes = pageBytes(snapshot, "Pages occupied by compressor");
  const inactiveBytes = pageBytes(snapshot, "Pages inactive");
  const usedParts = [activeBytes, wiredBytes, compressedBytes];

  return {
    totalBytes,
    pageSizeBytes: snapshot.pageSizeBytes,
    activeBytes,
    wiredBytes,
    compressedBytes,
    inactiveBytes,
    usedBytes: usedParts.every((part) => part !== null)
      ? usedParts.reduce<number>((sum, part) => sum + (part ?? 0), 0)
      : null,
    pressure
  };
}

function parseDf(output: string): DiskDiagnosis | null {
  const [, dataLine] = output.trim().split("\n");
  if (!dataLine) {
    return null;
  }

  const columns = dataLine.trim().split(/\s+/);
  const [filesystem, blocksText, usedText, availableText, capacity, mount] = columns;

  if (!filesystem || !blocksText || !usedText || !availableText || !capacity || !mount) {
    return null;
  }

  const totalBlocks = Number.parseInt(blocksText, 10);
  const usedBlocks = Number.parseInt(usedText, 10);
  const availableBlocks = Number.parseInt(availableText, 10);

  if (![totalBlocks, usedBlocks, availableBlocks].every(Number.isFinite)) {
    return null;
  }

  return {
    filesystem,
    totalBytes: totalBlocks * 1024,
    usedBytes: usedBlocks * 1024,
    availableBytes: availableBlocks * 1024,
    capacity,
    mount
  };
}

async function diagnoseDisk(): Promise<DiskDiagnosis | null> {
  const { stdout } = await execa("df", ["-k", "/"], { reject: false });
  return parseDf(stdout);
}

export async function diagnose(): Promise<DoctorDiagnosis> {
  const [memory, disk] = await Promise.all([diagnoseMemory(), diagnoseDisk()]);
  const [oneMinute, fiveMinutes, fifteenMinutes] = loadavg();

  return {
    scannedAt: new Date(),
    memory,
    disk,
    cpu: {
      loadAverage: [oneMinute ?? 0, fiveMinutes ?? 0, fifteenMinutes ?? 0],
      cpuCount: cpus().length
    }
  };
}
