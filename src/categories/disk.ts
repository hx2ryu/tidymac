import { execa } from "execa";
import {
  emptyDirectoryContents,
  expandHome,
  getDirectorySize,
  getExistingDirectorySize,
  isDirectory,
  isSafeUserPath,
  pathExists
} from "../lib/fs.js";
import type { CleanableItem, ExecuteResult, RiskLevel, ScanResult } from "../lib/types.js";

interface DirectoryGroup {
  id: string;
  label: string;
  description: string;
  paths: string[];
  risk: RiskLevel;
}

async function commandExists(command: string): Promise<boolean> {
  const result = await execa("which", [command], { reject: false });
  return result.exitCode === 0;
}

function parseByteText(input: string): number | null {
  const match = input.match(/([\d.]+)\s*([KMGTPE]?i?B)/i);
  if (!match?.[1] || !match[2]) {
    return null;
  }

  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) {
    return null;
  }

  const unit = match[2].toUpperCase();
  const powers: Record<string, number> = {
    B: 0,
    KB: 1,
    KIB: 1,
    MB: 2,
    MIB: 2,
    GB: 3,
    GIB: 3,
    TB: 4,
    TIB: 4,
    PB: 5,
    PIB: 5,
    EB: 6,
    EIB: 6
  };
  const power = powers[unit];

  if (power === undefined) {
    return null;
  }

  return Math.round(value * 1024 ** power);
}

async function existingDirectories(paths: string[]): Promise<string[]> {
  const checks = await Promise.all(
    paths.map(async (path) => ({
      path,
      exists: await isDirectory(path)
    }))
  );
  return checks.filter((check) => check.exists).map((check) => check.path);
}

async function makeDirectoryGroupItem(group: DirectoryGroup): Promise<CleanableItem | null> {
  const paths = await existingDirectories(group.paths);
  if (paths.length === 0) {
    return null;
  }

  const reclaimableBytes = await getExistingDirectorySize(paths);
  if (reclaimableBytes <= 0) {
    return null;
  }

  return {
    id: group.id,
    category: "disk",
    label: group.label,
    description: group.description,
    risk: group.risk,
    reclaimableBytes,
    requiresSudo: false,
    meta: {
      paths
    },
    execute: async ({ dryRun }): Promise<ExecuteResult> => {
      if (dryRun) {
        return {
          success: true,
          reclaimedBytes: reclaimableBytes,
          message: `${paths.length}개 디렉터리의 내용 정리 예정입니다.`
        };
      }

      const before = await getExistingDirectorySize(paths);
      for (const path of paths) {
        await emptyDirectoryContents(path);
      }
      const after = await getExistingDirectorySize(paths);

      return {
        success: true,
        reclaimedBytes: Math.max(0, before - after),
        message: `${paths.length}개 디렉터리의 내용을 정리했습니다.`
      };
    }
  };
}

async function getCommandOutput(command: string, args: string[]): Promise<string | null> {
  if (!(await commandExists(command))) {
    return null;
  }

  const { stdout, exitCode } = await execa(command, args, { reject: false });
  if (exitCode !== 0) {
    return null;
  }

  return stdout.trim() || null;
}

async function scanPackageManagerCaches(): Promise<CleanableItem | null> {
  const candidates: Array<{ manager: string; path: string }> = [];
  const npmPath = await getCommandOutput("npm", ["config", "get", "cache"]);
  const pnpmPath = await getCommandOutput("pnpm", ["store", "path"]);
  const yarnPath = await getCommandOutput("yarn", ["cache", "dir"]);

  for (const [manager, path] of [
    ["npm", npmPath],
    ["pnpm", pnpmPath],
    ["yarn", yarnPath]
  ] as const) {
    if (path && isSafeUserPath(path) && (await pathExists(path))) {
      candidates.push({ manager, path });
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  const paths = candidates.map((candidate) => candidate.path);
  const reclaimableBytes = await getExistingDirectorySize(paths);
  if (reclaimableBytes <= 0) {
    return null;
  }

  return {
    id: "disk-js-package-manager-caches",
    category: "disk",
    label: "npm/pnpm/yarn 캐시",
    description: "JavaScript 패키지 매니저 캐시를 공식 정리 명령으로 정리합니다.",
    risk: "safe",
    reclaimableBytes,
    requiresSudo: false,
    meta: {
      caches: candidates
    },
    execute: async ({ dryRun }): Promise<ExecuteResult> => {
      if (dryRun) {
        return {
          success: true,
          reclaimedBytes: reclaimableBytes,
          message: "npm cache clean, pnpm store prune, yarn cache clean 실행 예정입니다."
        };
      }

      const before = await getExistingDirectorySize(paths);
      const failures: string[] = [];

      if (candidates.some((candidate) => candidate.manager === "npm")) {
        const result = await execa("npm", ["cache", "clean", "--force"], { reject: false });
        if (result.exitCode !== 0) {
          failures.push(`npm: ${result.stderr || result.stdout || "실패"}`);
        }
      }

      if (candidates.some((candidate) => candidate.manager === "pnpm")) {
        const result = await execa("pnpm", ["store", "prune"], { reject: false });
        if (result.exitCode !== 0) {
          failures.push(`pnpm: ${result.stderr || result.stdout || "실패"}`);
        }
      }

      if (candidates.some((candidate) => candidate.manager === "yarn")) {
        const result = await execa("yarn", ["cache", "clean"], { reject: false });
        if (result.exitCode !== 0) {
          failures.push(`yarn: ${result.stderr || result.stdout || "실패"}`);
        }
      }

      const after = await getExistingDirectorySize(paths);

      return {
        success: failures.length === 0,
        reclaimedBytes: Math.max(0, before - after),
        message: failures.length === 0
          ? "패키지 매니저 캐시를 정리했습니다."
          : `일부 캐시 정리에 실패했습니다: ${failures.join("; ")}`
      };
    }
  };
}

async function scanMetroCaches(): Promise<CleanableItem | null> {
  const result = await execa(
    "find",
    ["/private/var/folders", "-type", "d", "-name", "metro-*", "-prune"],
    { reject: false }
  );
  const paths = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && isSafeUserPath(line));

  if (paths.length === 0) {
    return null;
  }

  const reclaimableBytes = await getExistingDirectorySize(paths);
  if (reclaimableBytes <= 0) {
    return null;
  }

  return {
    id: "disk-metro-var-folders-cache",
    category: "disk",
    label: "Metro 임시 캐시",
    description: "/private/var/folders 아래의 metro-* 캐시 내용을 정리합니다.",
    risk: "safe",
    reclaimableBytes,
    requiresSudo: false,
    meta: {
      paths
    },
    execute: async ({ dryRun }): Promise<ExecuteResult> => {
      if (dryRun) {
        return {
          success: true,
          reclaimedBytes: reclaimableBytes,
          message: `${paths.length}개 Metro 캐시 디렉터리 정리 예정입니다.`
        };
      }

      const before = await getExistingDirectorySize(paths);
      for (const path of paths) {
        await emptyDirectoryContents(path);
      }
      const after = await getExistingDirectorySize(paths);

      return {
        success: true,
        reclaimedBytes: Math.max(0, before - after),
        message: `${paths.length}개 Metro 캐시 디렉터리를 정리했습니다.`
      };
    }
  };
}

function parseBrewCleanupBytes(output: string): number | null {
  const freeMatch = output.match(/free approximately\s+([\d.]+\s*[KMGTPE]?i?B)/i);
  if (freeMatch?.[1]) {
    return parseByteText(freeMatch[1]);
  }

  const byteMatches = [...output.matchAll(/\(([\d.]+\s*[KMGTPE]?i?B)\)/gi)];
  const total = byteMatches.reduce((sum, match) => sum + (match[1] ? parseByteText(match[1]) ?? 0 : 0), 0);
  return total > 0 ? total : null;
}

async function scanHomebrewCleanup(): Promise<CleanableItem | null> {
  if (!(await commandExists("brew"))) {
    return null;
  }

  const dryRun = await execa("brew", ["cleanup", "--dry-run"], { reject: false });
  if (dryRun.exitCode !== 0) {
    return null;
  }

  const dryRunOutput = (dryRun.stdout || dryRun.stderr).trim();
  if (!dryRunOutput) {
    return null;
  }

  const reclaimableBytes = parseBrewCleanupBytes(dryRunOutput);
  if (reclaimableBytes !== null && reclaimableBytes <= 0) {
    return null;
  }

  return {
    id: "disk-homebrew-cleanup",
    category: "disk",
    label: "Homebrew cleanup",
    description: "brew cleanup으로 오래된 formula, cask 캐시를 정리합니다.",
    risk: "safe",
    reclaimableBytes,
    requiresSudo: false,
    meta: {
      dryRunOutput
    },
    execute: async ({ dryRun: isDryRun }): Promise<ExecuteResult> => {
      if (isDryRun) {
        return {
          success: true,
          reclaimedBytes: reclaimableBytes,
          message: "brew cleanup 실행 예정입니다."
        };
      }

      const result = await execa("brew", ["cleanup"], { reject: false });
      return {
        success: result.exitCode === 0,
        reclaimedBytes: result.exitCode === 0 ? reclaimableBytes : null,
        message: result.exitCode === 0
          ? "Homebrew cleanup을 실행했습니다."
          : (result.stderr || result.stdout || "Homebrew cleanup 실행에 실패했습니다.")
      };
    }
  };
}

function parseDockerReclaimable(output: string): number | null {
  const total = output
    .split("\n")
    .map((line) => parseByteText(line))
    .reduce<number>((sum, bytes) => sum + (bytes ?? 0), 0);

  return total > 0 ? total : null;
}

async function scanDockerPrune(): Promise<CleanableItem | null> {
  if (!(await commandExists("docker"))) {
    return null;
  }

  const df = await execa("docker", ["system", "df", "--format", "{{.Reclaimable}}"], {
    reject: false
  });
  if (df.exitCode !== 0) {
    return null;
  }

  const reclaimableBytes = parseDockerReclaimable(df.stdout);
  if (reclaimableBytes === null || reclaimableBytes <= 0) {
    return null;
  }

  return {
    id: "disk-docker-system-prune",
    category: "disk",
    label: "Docker system prune",
    description: "중지된 컨테이너, 사용하지 않는 네트워크, dangling 이미지와 빌드 캐시를 정리합니다.",
    risk: "caution",
    reclaimableBytes,
    requiresSudo: false,
    meta: {
      dockerSystemDf: df.stdout
    },
    execute: async ({ dryRun }): Promise<ExecuteResult> => {
      if (dryRun) {
        return {
          success: true,
          reclaimedBytes: reclaimableBytes,
          message: "docker system prune -f 실행 예정입니다."
        };
      }

      const result = await execa("docker", ["system", "prune", "-f"], { reject: false });
      return {
        success: result.exitCode === 0,
        reclaimedBytes: result.exitCode === 0 ? reclaimableBytes : null,
        message: result.exitCode === 0
          ? "Docker system prune을 실행했습니다."
          : (result.stderr || result.stdout || "Docker system prune 실행에 실패했습니다.")
      };
    }
  };
}

async function makeCoreSimulatorCacheItem(): Promise<CleanableItem | null> {
  const basePaths = [
    "~/Library/Developer/CoreSimulator/Caches"
  ];
  const candidatePaths: string[] = [];

  for (const path of basePaths) {
    if (await isDirectory(path)) {
      candidatePaths.push(path);
    }
  }

  const tmpPath = expandHome("~/Library/Developer/CoreSimulator/Devices");
  if (await isDirectory(tmpPath)) {
    const result = await execa("find", [tmpPath, "-type", "d", "-name", "Caches", "-prune"], {
      reject: false
    });
    for (const line of result.stdout.split("\n")) {
      const path = line.trim();
      if (path && isSafeUserPath(path)) {
        candidatePaths.push(path);
      }
    }
  }

  const paths = [...new Set(candidatePaths)];
  return makeDirectoryGroupItem({
    id: "disk-coresimulator-caches",
    label: "CoreSimulator 캐시",
    description: "iOS Simulator가 재생성할 수 있는 CoreSimulator 캐시 내용을 정리합니다.",
    paths,
    risk: "safe"
  });
}

async function scanDirectoryGroups(): Promise<Array<CleanableItem | null>> {
  const groups: DirectoryGroup[] = [
    {
      id: "disk-user-library-caches",
      label: "사용자 Library 캐시",
      description: "~/Library/Caches 내용을 정리합니다.",
      paths: ["~/Library/Caches"],
      risk: "safe"
    },
    {
      id: "disk-xcode-derived-data",
      label: "Xcode DerivedData",
      description: "Xcode 빌드 산출물과 인덱스 캐시를 정리합니다.",
      paths: ["~/Library/Developer/Xcode/DerivedData"],
      risk: "safe"
    },
    {
      id: "disk-xcode-archives",
      label: "Xcode Archives",
      description: "보관된 Xcode archive 내용을 정리합니다. 필요한 배포 산출물이 없는지 확인하세요.",
      paths: ["~/Library/Developer/Xcode/Archives"],
      risk: "caution"
    },
    {
      id: "disk-gradle-caches",
      label: "Gradle 캐시",
      description: "Gradle 캐시, 데몬, native 캐시 내용을 정리합니다.",
      paths: ["~/.gradle/caches", "~/.gradle/daemon", "~/.gradle/native"],
      risk: "caution"
    },
    {
      id: "disk-user-logs",
      label: "사용자 로그",
      description: "~/Library/Logs 내용을 정리합니다.",
      paths: ["~/Library/Logs"],
      risk: "safe"
    }
  ];

  return Promise.all(groups.map((group) => makeDirectoryGroupItem(group)));
}

export async function scanDisk(): Promise<ScanResult> {
  const items = (
    await Promise.all([
      ...(await scanDirectoryGroups()),
      makeCoreSimulatorCacheItem(),
      scanPackageManagerCaches(),
      scanHomebrewCleanup(),
      scanDockerPrune(),
      scanMetroCaches()
    ])
  ).filter((item): item is CleanableItem => item !== null);

  return {
    category: "disk",
    items,
    scannedAt: new Date()
  };
}
