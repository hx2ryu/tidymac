import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { HistoryEntry } from "./types.js";

const HISTORY_LIMIT = 1000;
const HISTORY_PATH = join(homedir(), ".tidymac", "history.json");

function isHistoryEntry(value: unknown): value is HistoryEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<HistoryEntry>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.executedAt === "string" &&
    typeof candidate.category === "string" &&
    typeof candidate.itemId === "string" &&
    typeof candidate.label === "string" &&
    typeof candidate.risk === "string" &&
    typeof candidate.requiresSudo === "boolean" &&
    typeof candidate.dryRun === "boolean" &&
    typeof candidate.success === "boolean" &&
    (typeof candidate.reclaimedBytes === "number" || candidate.reclaimedBytes === null) &&
    typeof candidate.message === "string"
  );
}

export function getHistoryPath(): string {
  return HISTORY_PATH;
}

export async function readHistory(limit = 100): Promise<HistoryEntry[]> {
  try {
    const raw = await readFile(HISTORY_PATH, "utf8");
    const parsed: unknown = JSON.parse(raw);
    const entries = Array.isArray(parsed) ? parsed.filter(isHistoryEntry) : [];
    return entries.slice(-Math.max(0, limit)).reverse();
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

export async function appendHistory(entry: HistoryEntry): Promise<void> {
  await appendHistoryEntries([entry]);
}

export async function appendHistoryEntries(entries: HistoryEntry[]): Promise<void> {
  await mkdir(dirname(HISTORY_PATH), { recursive: true });

  let current: HistoryEntry[] = [];
  try {
    current = (await readHistory(HISTORY_LIMIT)).reverse();
  } catch {
    current = [];
  }

  const next = [...current, ...entries].slice(-HISTORY_LIMIT);
  const tempPath = `${HISTORY_PATH}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await rename(tempPath, HISTORY_PATH);
}
