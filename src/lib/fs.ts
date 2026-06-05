import { existsSync, realpathSync } from "node:fs";
import { access, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { execa } from "execa";

const BLOCKED_ROOTS = ["/System", "/Library", "/usr", "/bin", "/sbin", "/etc"];
const ALLOWED_ROOTS = [
  homedir(),
  "/private/var/folders",
  "/tmp",
  "/private/tmp",
  "/var/tmp",
  "/private/var/tmp"
];

export interface DirectoryCleanupFailure {
  path: string;
  code: string | null;
  message: string;
}

export interface DirectoryCleanupResult {
  attemptedEntries: number;
  removedEntries: number;
  skippedEntries: number;
  failures: DirectoryCleanupFailure[];
}

export function expandHome(input: string): string {
  if (input === "~") {
    return homedir();
  }

  if (input.startsWith("~/")) {
    return join(homedir(), input.slice(2));
  }

  return input;
}

function normalizePath(input: string): string {
  const expanded = expandHome(input);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(process.cwd(), expanded);
}

function normalizeExistingPath(input: string): string {
  const normalized = normalizePath(input);
  if (!existsSync(normalized)) {
    return normalized;
  }

  try {
    return realpathSync.native(normalized);
  } catch {
    return normalized;
  }
}

function isSameOrChild(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

export function isSafeUserPath(input: string): boolean {
  const normalized = normalizeExistingPath(input);

  if (BLOCKED_ROOTS.some((root) => isSameOrChild(normalized, root))) {
    return false;
  }

  return ALLOWED_ROOTS.some((root) => isSameOrChild(normalized, resolve(root)));
}

export async function pathExists(input: string): Promise<boolean> {
  try {
    await access(expandHome(input));
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(input: string): Promise<boolean> {
  try {
    return (await stat(expandHome(input))).isDirectory();
  } catch {
    return false;
  }
}

export async function getDirectorySize(input: string): Promise<number> {
  const expanded = expandHome(input);

  if (!(await pathExists(expanded))) {
    return 0;
  }

  const { stdout } = await execa("du", ["-sk", expanded], { reject: false });
  const [sizeKbText] = stdout.trim().split(/\s+/);
  const sizeKb = Number.parseInt(sizeKbText ?? "0", 10);

  if (!Number.isFinite(sizeKb) || Number.isNaN(sizeKb)) {
    return 0;
  }

  return sizeKb * 1024;
}

export async function getExistingDirectorySize(paths: string[]): Promise<number> {
  const sizes = await Promise.all(paths.map((path) => getDirectorySize(path)));
  return sizes.reduce((sum, size) => sum + size, 0);
}

function getErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function removeDirectoryEntry(path: string): Promise<DirectoryCleanupFailure | null> {
  try {
    await rm(path, {
      force: true,
      recursive: true,
      maxRetries: 2
    });
    return null;
  } catch (error) {
    const code = getErrorCode(error);
    if (code === "ENOENT") {
      return null;
    }

    return {
      path,
      code,
      message: getErrorMessage(error)
    };
  }
}

export async function emptyDirectoryContents(input: string): Promise<DirectoryCleanupResult> {
  const expanded = expandHome(input);

  if (!isSafeUserPath(expanded)) {
    throw new Error(`안전하지 않은 경로라서 정리하지 않았습니다: ${expanded}`);
  }

  if (!(await isDirectory(expanded))) {
    return {
      attemptedEntries: 0,
      removedEntries: 0,
      skippedEntries: 0,
      failures: []
    };
  }

  const entries = await readdir(expanded, { withFileTypes: true });
  const failures = (
    await Promise.all(entries.map((entry) => removeDirectoryEntry(join(expanded, entry.name))))
  ).filter((failure): failure is DirectoryCleanupFailure => failure !== null);

  return {
    attemptedEntries: entries.length,
    removedEntries: entries.length - failures.length,
    skippedEntries: failures.length,
    failures
  };
}

export async function removeSafePath(input: string): Promise<void> {
  const expanded = expandHome(input);

  if (!isSafeUserPath(expanded)) {
    throw new Error(`안전하지 않은 경로라서 삭제하지 않았습니다: ${expanded}`);
  }

  await rm(expanded, {
    force: true,
    recursive: true,
    maxRetries: 2
  });
}
