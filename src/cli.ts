#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { platform } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import chalk, { type ChalkInstance } from "chalk";
import { Command, type Help } from "commander";
import inquirer from "inquirer";
import ora from "ora";
import prettyBytes from "pretty-bytes";
import stringWidth from "string-width";
import { scanCpu } from "./categories/cpu.js";
import { scanDisk } from "./categories/disk.js";
import { scanMemory } from "./categories/memory.js";
import { scanNetwork } from "./categories/network.js";
import { diagnose } from "./lib/doctor.js";
import { appendHistoryEntries, readHistory } from "./lib/history.js";
import type {
  CategoryId,
  CleanableItem,
  ExecuteResult,
  HistoryEntry,
  RiskLevel,
  ScanResult,
  DoctorDiagnosis
} from "./lib/types.js";

const CATEGORY_IDS = ["memory", "disk", "cpu", "network"] as const satisfies readonly CategoryId[];

const CATEGORY_LABELS: Record<CategoryId, string> = {
  memory: "메모리",
  disk: "디스크",
  cpu: "CPU",
  network: "네트워크"
};

const RISK_LABELS: Record<RiskLevel, string> = {
  safe: "안전",
  caution: "주의",
  danger: "위험"
};

const RISK_COLORS: Record<RiskLevel, ChalkInstance> = {
  safe: chalk.green,
  caution: chalk.yellow,
  danger: chalk.red
};

const SCANNERS: Record<CategoryId, () => Promise<ScanResult>> = {
  memory: scanMemory,
  disk: scanDisk,
  cpu: scanCpu,
  network: scanNetwork
};

const PANEL_MAX_WIDTH = 108;
const PANEL_MIN_WIDTH = 72;
const MIN_TERMINAL_WIDTH = 40;

interface CleanOptions {
  category?: string;
  dryRun?: boolean;
  force?: boolean;
}

interface ScanOptions {
  category?: string;
}

interface HistoryOptions {
  limit?: string;
}

interface DoctorOptions {
  watch?: boolean;
  interval?: string;
}

interface ExecutionRecord {
  item: CleanableItem;
  result: ExecuteResult;
}

type ExecutionStatus = "pending" | "running" | "success" | "failed";

interface ExecutionProgressEntry {
  item: CleanableItem;
  status: ExecutionStatus;
  result?: ExecuteResult;
  startedAt?: number;
  finishedAt?: number;
}

function ensureDarwin(): void {
  if (platform() !== "darwin") {
    console.error(chalk.red("tidymac은 macOS에서만 실행할 수 있습니다."));
    process.exit(1);
  }
}

function parseCategory(category: string | undefined): CategoryId | undefined {
  if (category === undefined) {
    return undefined;
  }

  if ((CATEGORY_IDS as readonly string[]).includes(category)) {
    return category as CategoryId;
  }

  throw new Error(`알 수 없는 카테고리입니다: ${category}. 사용 가능: ${CATEGORY_IDS.join(", ")}`);
}

function formatBytes(bytes: number | null): string {
  return bytes === null ? chalk.gray("크기 미확정") : prettyBytes(bytes);
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function terminalWidth(): number {
  const columns = process.stdout.columns;

  if (columns === undefined) {
    return Math.round(clamp(96, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH));
  }

  return Math.round(clamp(columns, Math.min(columns, MIN_TERMINAL_WIDTH), Math.min(columns, PANEL_MAX_WIDTH)));
}

function visiblePadEnd(input: string, width: number): string {
  const remaining = width - stringWidth(input);
  return remaining > 0 ? `${input}${" ".repeat(remaining)}` : input;
}

function visiblePadStart(input: string, width: number): string {
  const remaining = width - stringWidth(input);
  return remaining > 0 ? `${" ".repeat(remaining)}${input}` : input;
}

function truncateText(input: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return "";
  }

  if (stringWidth(input) <= maxWidth) {
    return input;
  }

  const ellipsis = "…";
  const ansiPattern = /^\x1B\[[0-?]*[ -/]*[@-~]/;
  let output = "";
  let visibleWidth = 0;
  let index = 0;

  while (index < input.length) {
    const sequence = input.slice(index).match(ansiPattern)?.[0];
    if (sequence) {
      output += sequence;
      index += sequence.length;
      continue;
    }

    const codePoint = input.codePointAt(index);
    if (codePoint === undefined) {
      break;
    }

    const char = String.fromCodePoint(codePoint);
    const nextWidth = visibleWidth + stringWidth(char);
    if (nextWidth + stringWidth(ellipsis) > maxWidth) {
      break;
    }

    visibleWidth = nextWidth;
    output += char;
    index += char.length;
  }

  return `${output}\x1B[0m${ellipsis}`;
}

function renderBoxLines(title: string, lines: string[], options?: { color?: ChalkInstance; width?: number }): string[] {
  const width = options?.width ?? terminalWidth();
  const color = options?.color ?? chalk.gray;
  const innerWidth = Math.max(20, width - 4);
  const titleText = title ? truncateText(` ${title} `, Math.max(0, width - 3)) : "";
  const topFillWidth = titleText ? Math.max(0, width - stringWidth(titleText) - 3) : width - 2;
  const top = titleText
    ? `${color("╭")}${color("─")}${chalk.bold(titleText)}${color("─".repeat(topFillWidth))}${color("╮")}`
    : `${color("╭")}${color("─".repeat(width - 2))}${color("╮")}`;

  const renderedLines = [top];
  for (const line of lines) {
    const content = truncateText(line, innerWidth);
    renderedLines.push(`${color("│")} ${visiblePadEnd(content, innerWidth)} ${color("│")}`);
  }
  renderedLines.push(`${color("╰")}${color("─".repeat(width - 2))}${color("╯")}`);
  return renderedLines;
}

function printBox(title: string, lines: string[], options?: { color?: ChalkInstance; width?: number }): void {
  console.log(renderBoxLines(title, lines, options).join("\n"));
}

function printSpacer(): void {
  console.log("");
}

function statusColor(value: number, warnAt = 0.7, dangerAt = 0.9): ChalkInstance {
  if (value >= dangerAt) {
    return chalk.red;
  }

  if (value >= warnAt) {
    return chalk.yellow;
  }

  return chalk.green;
}

function availabilityColor(value: number, warnBelow = 0.25, dangerBelow = 0.1): ChalkInstance {
  if (value <= dangerBelow) {
    return chalk.red;
  }

  if (value <= warnBelow) {
    return chalk.yellow;
  }

  return chalk.green;
}

function renderGauge(value: number, options?: { width?: number; warnAt?: number; dangerAt?: number }): string {
  const width = options?.width ?? 24;
  const normalized = clamp(value, 0, 1);
  const filled = Math.round(normalized * width);
  const empty = width - filled;
  const color = statusColor(normalized, options?.warnAt, options?.dangerAt);
  return `${color("█".repeat(filled))}${chalk.gray("░".repeat(empty))}`;
}

function renderAvailabilityGauge(
  value: number,
  options?: { width?: number; warnBelow?: number; dangerBelow?: number }
): string {
  const width = options?.width ?? 24;
  const normalized = clamp(value, 0, 1);
  const filled = Math.round(normalized * width);
  const empty = width - filled;
  const color = availabilityColor(normalized, options?.warnBelow, options?.dangerBelow);
  return `${color("█".repeat(filled))}${chalk.gray("░".repeat(empty))}`;
}

function renderNeutralGauge(value: number, options?: { width?: number; color?: ChalkInstance }): string {
  const width = options?.width ?? 24;
  const normalized = clamp(value, 0, 1);
  const filled = Math.round(normalized * width);
  const empty = width - filled;
  const color = options?.color ?? chalk.cyan;
  return `${color("█".repeat(filled))}${chalk.gray("░".repeat(empty))}`;
}

function renderUnknownGauge(width = 24): string {
  return chalk.gray("░".repeat(width));
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));

  if (totalSeconds === 0) {
    return "0초";
  }

  if (totalSeconds < 60) {
    return `${totalSeconds}초`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return `${totalMinutes}분 ${seconds.toString().padStart(2, "0")}초`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}시간 ${minutes.toString().padStart(2, "0")}분`;
}

function ratioOrNull(used: number | null, total: number | null): number | null {
  if (used === null || total === null || total <= 0) {
    return null;
  }

  return used / total;
}

function formatMetricLine(
  label: string,
  ratio: number | null,
  detail: string,
  options?: {
    width?: number;
    availability?: boolean;
    warnAt?: number;
    dangerAt?: number;
    warnBelow?: number;
    dangerBelow?: number;
  }
): string {
  const labelText = visiblePadEnd(label, 10);
  const gauge =
    ratio === null
      ? renderUnknownGauge(options?.width ?? 24)
      : options?.availability === true
        ? renderAvailabilityGauge(ratio, {
            width: options.width,
            warnBelow: options.warnBelow,
            dangerBelow: options.dangerBelow
          })
        : renderGauge(ratio, {
            width: options?.width,
            warnAt: options?.warnAt,
            dangerAt: options?.dangerAt
          });
  const percent = ratio === null ? chalk.gray("--") : formatPercent(Math.max(0, ratio));
  return `${labelText} ${gauge} ${visiblePadStart(percent, 4)}  ${detail}`;
}

function riskBadge(risk: RiskLevel): string {
  if (risk === "safe") {
    return `${chalk.green("🟢")} ${RISK_LABELS[risk]}`;
  }

  if (risk === "caution") {
    return `${chalk.yellow("🟡")} ${RISK_LABELS[risk]}`;
  }

  return `${chalk.red("🔴")} ${RISK_LABELS[risk]}`;
}

function sudoBadge(item: CleanableItem): string {
  return item.requiresSudo ? `${chalk.magenta("[sudo]")} ` : "";
}

function categoryBadge(category: CategoryId): string {
  return chalk.cyan(`[${CATEGORY_LABELS[category]}]`);
}

function localizeHelpTerm(term: string): string {
  return term.replaceAll("[options]", "[옵션]").replaceAll("[command]", "[명령어]");
}

function formatHelpRows(rows: Array<{ term: string; description: string }>): string {
  const width = rows.reduce((max, row) => Math.max(max, row.term.length), 0);
  return rows
    .map((row) => `  ${localizeHelpTerm(row.term.padEnd(width))}  ${row.description}`)
    .join("\n");
}

function formatHelpKorean(command: Command, helper: Help): string {
  const sections: string[] = [`사용법: ${localizeHelpTerm(helper.commandUsage(command))}`];
  const description = helper.commandDescription(command);

  if (description) {
    sections.push(description);
  }

  const args = helper.visibleArguments(command).map((argument) => ({
    term: helper.argumentTerm(argument),
    description: helper.argumentDescription(argument)
  }));
  if (args.length > 0) {
    sections.push(`인자:\n${formatHelpRows(args)}`);
  }

  const options = helper.visibleOptions(command).map((option) => ({
    term: helper.optionTerm(option),
    description: helper.optionDescription(option)
  }));
  if (options.length > 0) {
    sections.push(`옵션:\n${formatHelpRows(options)}`);
  }

  const commands = helper.visibleCommands(command).map((subcommand) => ({
    term: helper.subcommandTerm(subcommand),
    description: helper.subcommandDescription(subcommand)
  }));
  if (commands.length > 0) {
    sections.push(`명령어:\n${formatHelpRows(commands)}`);
  }

  return `${sections.join("\n\n")}\n`;
}

function localizeCommanderError(message: string): string {
  return message
    .replace(/^error:/, "오류:")
    .replace(/unknown command '([^']+)'/, "알 수 없는 명령어입니다: '$1'")
    .replace(/unknown option '([^']+)'/, "알 수 없는 옵션입니다: '$1'")
    .replace(/missing required argument '([^']+)'/, "필수 인자가 없습니다: '$1'")
    .replace(/option '([^']+)' argument missing/, "옵션 '$1'에 필요한 값이 없습니다");
}

function sumKnownBytes(items: Array<{ reclaimedBytes?: number | null; reclaimableBytes?: number | null }>): number {
  return items.reduce((sum, item) => sum + (item.reclaimedBytes ?? item.reclaimableBytes ?? 0), 0);
}

function countUnknownBytes(items: Array<{ reclaimedBytes?: number | null; reclaimableBytes?: number | null }>): number {
  return items.filter((item) => (item.reclaimedBytes ?? item.reclaimableBytes ?? null) === null).length;
}

function countByRisk(items: CleanableItem[]): Record<RiskLevel, number> {
  return {
    safe: items.filter((item) => item.risk === "safe").length,
    caution: items.filter((item) => item.risk === "caution").length,
    danger: items.filter((item) => item.risk === "danger").length
  };
}

function riskDistributionLines(items: CleanableItem[], width = 18): string[] {
  const total = items.length;
  const counts = countByRisk(items);

  if (total === 0) {
    return [];
  }

  return (["safe", "caution", "danger"] as const).map((risk) => {
    const count = counts[risk];
    const ratio = count / total;
    return `${visiblePadEnd(RISK_LABELS[risk], 4)} ${renderNeutralGauge(ratio, {
      width,
      color: RISK_COLORS[risk]
    })} ${count}개`;
  });
}

async function scanCategories(category?: CategoryId): Promise<ScanResult[]> {
  const categories = category ? [category] : [...CATEGORY_IDS];
  const results: ScanResult[] = [];

  for (const categoryId of categories) {
    const spinner = ora(`${CATEGORY_LABELS[categoryId]} 스캔 중...`).start();
    try {
      const result = await SCANNERS[categoryId]();
      spinner.succeed(`${CATEGORY_LABELS[categoryId]} 스캔 완료: ${result.items.length}개 항목`);
      results.push(result);
    } catch (error) {
      spinner.fail(`${CATEGORY_LABELS[categoryId]} 스캔 실패`);
      throw error;
    }
  }

  return results;
}

function flattenItems(results: ScanResult[]): CleanableItem[] {
  return results.flatMap((result) => result.items);
}

function printScanResults(results: ScanResult[]): void {
  const allItems = flattenItems(results);
  if (allItems.length === 0) {
    console.log(chalk.green("정리 가능 항목이 없습니다."));
    return;
  }

  printSpacer();
  const totalKnown = sumKnownBytes(allItems);
  const totalUnknown = countUnknownBytes(allItems);
  const counts = countByRisk(allItems);

  printBox(
    "tidymac scan",
    [
      `${chalk.gray("정리 후보")} ${chalk.bold(`${allItems.length}개`)}   ${chalk.gray("예상 회수")} ${chalk.bold(
        formatBytes(totalKnown)
      )}   ${chalk.gray("크기 미확정")} ${totalUnknown}개`,
      `${chalk.green("safe")} ${counts.safe}   ${chalk.yellow("caution")} ${counts.caution}   ${chalk.red(
        "danger"
      )} ${counts.danger}`,
      ...riskDistributionLines(allItems, 22)
    ],
    { color: chalk.cyan }
  );

  for (const result of results) {
    if (result.items.length === 0) {
      continue;
    }

    printSpacer();
    const knownTotal = sumKnownBytes(result.items);
    const unknownCount = countUnknownBytes(result.items);
    const categoryRatio = totalKnown > 0 ? knownTotal / totalKnown : 0;
    const boxWidth = terminalWidth();
    const innerWidth = boxWidth - 4;
    const lines = [
      `${chalk.gray("요약")} ${result.items.length}개 항목   ${chalk.gray("예상 회수")} ${formatBytes(
        knownTotal
      )}${unknownCount > 0 ? chalk.gray(`   크기 미확정 ${unknownCount}개`) : ""}`,
      `${chalk.gray("회수 비중")} ${renderNeutralGauge(categoryRatio, {
        width: 24,
        color: chalk.cyan
      })} ${formatPercent(categoryRatio)}`
    ];

    for (const item of result.items) {
      const itemRatio = knownTotal > 0 && item.reclaimableBytes !== null ? item.reclaimableBytes / knownTotal : 0;
      const gauge =
        item.reclaimableBytes === null
          ? renderUnknownGauge(12)
          : renderNeutralGauge(itemRatio, { width: 12, color: RISK_COLORS[item.risk] });
      const left = `${gauge} ${riskBadge(item.risk)} ${sudoBadge(item)}${chalk.bold(
        truncateText(item.label, 36)
      )}`;
      const right = chalk.gray(formatBytes(item.reclaimableBytes));
      const gapWidth = Math.max(2, innerWidth - stringWidth(left) - stringWidth(right));
      lines.push(`${left}${" ".repeat(gapWidth)}${right}`);
      lines.push(chalk.gray(`  ${truncateText(item.description, innerWidth - 2)}`));
    }

    printBox(CATEGORY_LABELS[result.category], lines, { color: chalk.gray, width: boxWidth });
  }
}

async function selectItems(items: CleanableItem[], force: boolean): Promise<CleanableItem[]> {
  if (force) {
    const safeItems = items.filter((item) => item.risk === "safe");
    console.log(chalk.gray(`--force: 안전 항목 ${safeItems.length}개를 자동 선택했습니다.`));
    return safeItems;
  }

  const answers = await inquirer.prompt<{ selectedIds: string[] }>([
    {
      type: "checkbox",
      name: "selectedIds",
      message: "정리할 항목을 선택하세요.",
      pageSize: 15,
      choices: items.map((item) => ({
        name: `${riskBadge(item.risk)} ${sudoBadge(item)}${categoryBadge(item.category)} ${
          item.label
        } ${chalk.gray(formatBytes(item.reclaimableBytes))}`,
        short: item.label,
        value: item.id,
        checked: item.risk === "safe"
      }))
    }
  ]);

  const selectedIds = new Set(answers.selectedIds);
  return items.filter((item) => selectedIds.has(item.id));
}

async function confirmRiskyItems(items: CleanableItem[], dryRun: boolean): Promise<boolean> {
  const riskyItems = items.filter((item) => item.risk !== "safe");
  if (dryRun || riskyItems.length === 0) {
    return true;
  }

  console.log("");
  console.log(chalk.yellow("주의/위험 항목이 선택되었습니다."));
  for (const item of riskyItems) {
    console.log(`  ${riskBadge(item.risk)} ${categoryBadge(item.category)} ${item.label}`);
  }

  const answers = await inquirer.prompt<{ confirmed: boolean }>([
    {
      type: "confirm",
      name: "confirmed",
      message: "선택한 주의/위험 항목을 실제로 실행할까요?",
      default: false
    }
  ]);

  return answers.confirmed;
}

function makeHistoryEntry(item: CleanableItem, result: ExecuteResult, dryRun: boolean): HistoryEntry {
  return {
    id: randomUUID(),
    executedAt: new Date().toISOString(),
    category: item.category,
    itemId: item.id,
    label: item.label,
    risk: item.risk,
    requiresSudo: item.requiresSudo,
    dryRun,
    success: result.success,
    reclaimedBytes: result.reclaimedBytes,
    message: result.message
  };
}

const PROGRESS_REFRESH_MS = 250;
const PROGRESS_LIST_LIMIT = 6;

function isCompletedProgress(entry: ExecutionProgressEntry): boolean {
  return entry.status === "success" || entry.status === "failed";
}

function progressSymbol(status: ExecutionStatus): string {
  if (status === "running") {
    return chalk.cyan("▶");
  }

  if (status === "success") {
    return chalk.green("✓");
  }

  if (status === "failed") {
    return chalk.red("✗");
  }

  return chalk.gray("•");
}

function progressItemLabel(item: CleanableItem): string {
  return `${CATEGORY_LABELS[item.category]} · ${item.requiresSudo ? "[sudo] " : ""}${item.label}`;
}

function progressEntryDuration(entry: ExecutionProgressEntry, now: number): string | null {
  if (entry.startedAt === undefined) {
    return null;
  }

  return formatDuration((entry.finishedAt ?? now) - entry.startedAt);
}

function formatProgressEntry(entry: ExecutionProgressEntry, now: number, innerWidth: number): string {
  const symbol = progressSymbol(entry.status);
  const label = progressItemLabel(entry.item);
  const bytes = entry.result ? entry.result.reclaimedBytes : entry.item.reclaimableBytes;
  const duration = progressEntryDuration(entry, now);
  const statusText =
    entry.status === "failed"
      ? chalk.red("실패")
      : entry.status === "success"
        ? chalk.green("완료")
        : entry.status === "running"
          ? chalk.cyan("진행")
          : chalk.gray("대기");
  const right = [statusText, chalk.gray(formatBytes(bytes)), duration ? chalk.gray(duration) : null]
    .filter((part): part is string => part !== null)
    .join(chalk.gray(" · "));
  const prefix = `${symbol} `;
  const maxLabelWidth = Math.max(8, innerWidth - stringWidth(prefix) - stringWidth(right) - 2);
  const left = `${prefix}${truncateText(label, maxLabelWidth)}`;
  const gapWidth = Math.max(1, innerWidth - stringWidth(left) - stringWidth(right));

  return `${left}${" ".repeat(gapWidth)}${right}`;
}

function averageCompletedDuration(entries: ExecutionProgressEntry[]): number | null {
  const durations = entries
    .filter(isCompletedProgress)
    .map((entry) =>
      entry.startedAt !== undefined && entry.finishedAt !== undefined ? entry.finishedAt - entry.startedAt : null
    )
    .filter((duration): duration is number => duration !== null && duration > 0);

  if (durations.length === 0) {
    return null;
  }

  return durations.reduce((sum, duration) => sum + duration, 0) / durations.length;
}

function estimateRemainingDuration(
  entries: ExecutionProgressEntry[],
  runningEntry: ExecutionProgressEntry | undefined,
  pendingCount: number,
  now: number
): number | null {
  if (entries.every(isCompletedProgress)) {
    return 0;
  }

  const averageDuration = averageCompletedDuration(entries);
  if (averageDuration === null) {
    return null;
  }

  const runningElapsed =
    runningEntry?.startedAt === undefined ? 0 : Math.max(0, now - runningEntry.startedAt);
  const runningRemaining = runningEntry
    ? Math.max(averageDuration - runningElapsed, averageDuration * 0.25)
    : 0;

  return runningRemaining + pendingCount * averageDuration;
}

function estimateProgressRatio(entries: ExecutionProgressEntry[], runningEntry: ExecutionProgressEntry | undefined, now: number): number {
  if (entries.length === 0) {
    return 1;
  }

  const completedCount = entries.filter(isCompletedProgress).length;
  const averageDuration = averageCompletedDuration(entries);
  const runningElapsed =
    runningEntry?.startedAt === undefined ? 0 : Math.max(0, now - runningEntry.startedAt);
  const runningFraction =
    runningEntry === undefined
      ? 0
      : averageDuration === null
        ? 0.1
        : clamp(runningElapsed / averageDuration, 0.05, 0.95);

  return clamp((completedCount + runningFraction) / entries.length, 0, 1);
}

function renderCleanProgress(entries: ExecutionProgressEntry[], dryRun: boolean, startedAt: number, now: number): string[] {
  const boxWidth = terminalWidth();
  const innerWidth = boxWidth - 4;
  const completedEntries = entries.filter(isCompletedProgress);
  const runningEntry = entries.find((entry) => entry.status === "running");
  const pendingEntries = entries.filter((entry) => entry.status === "pending");
  const failures = completedEntries.filter((entry) => entry.status === "failed").length;
  const remainingCount = pendingEntries.length + (runningEntry ? 1 : 0);
  const progressRatio = estimateProgressRatio(entries, runningEntry, now);
  const eta = estimateRemainingDuration(entries, runningEntry, pendingEntries.length, now);
  const plannedItems = entries.map((entry) => entry.item);
  const totalKnown = sumKnownBytes(plannedItems);
  const totalUnknown = countUnknownBytes(plannedItems);
  const reclaimedKnown = sumKnownBytes(completedEntries.map((entry) => entry.result ?? { reclaimedBytes: 0 }));
  const reclaimedUnknown = completedEntries.filter((entry) => entry.result?.reclaimedBytes === null).length;
  const completedLabel = `${completedEntries.length}/${entries.length}`;
  const failureLabel = failures > 0 ? chalk.red(`${failures}`) : `${failures}`;
  const modeLabel = dryRun ? chalk.cyan("dry-run") : chalk.green("실행");
  const gaugeColor = failures > 0 ? chalk.yellow : dryRun ? chalk.cyan : chalk.green;
  const lines: string[] = [
    `${chalk.gray("모드")} ${modeLabel}   ${chalk.gray("완료")} ${chalk.bold(
      completedLabel
    )}   ${chalk.gray("남음")} ${remainingCount}   ${chalk.gray("실패")} ${failureLabel}`,
    `${chalk.gray("진행률")} ${renderNeutralGauge(progressRatio, {
      width: 18,
      color: gaugeColor
    })} ${visiblePadStart(formatPercent(progressRatio), 4)}   ${chalk.gray("경과")} ${formatDuration(
      now - startedAt
    )}   ${chalk.gray("예상 남은")} ${eta === null ? chalk.gray("계산 중") : formatDuration(eta)}`,
    dryRun
      ? `${chalk.gray("예상 회수")} ${formatBytes(totalKnown)}${
          totalUnknown > 0 ? chalk.gray(`   크기 미확정 ${totalUnknown}개`) : ""
        }`
      : `${chalk.gray("회수")} ${formatBytes(reclaimedKnown)}${
          reclaimedUnknown > 0 ? chalk.gray(`   크기 미확정 ${reclaimedUnknown}개`) : ""
        }   ${chalk.gray("예상")} ${formatBytes(totalKnown)}${
          totalUnknown > 0 ? chalk.gray(`   미확정 ${totalUnknown}개`) : ""
        }`
  ];

  lines.push("");
  if (runningEntry) {
    lines.push(chalk.bold("진행 중"));
    lines.push(formatProgressEntry(runningEntry, now, innerWidth));
    lines.push(chalk.gray(`  ${truncateText(runningEntry.item.description, innerWidth - 2)}`));
  } else {
    lines.push(`${chalk.bold("진행 중")} ${chalk.gray("없음")}`);
  }

  lines.push("");
  lines.push(chalk.bold(`완료된 작업 ${completedEntries.length}개`));
  if (completedEntries.length === 0) {
    lines.push(chalk.gray("  아직 완료된 작업이 없습니다."));
  } else {
    const visibleCompleted = completedEntries.slice(-PROGRESS_LIST_LIMIT);
    const hiddenCompletedCount = completedEntries.length - visibleCompleted.length;
    if (hiddenCompletedCount > 0) {
      lines.push(chalk.gray(`  이전 완료 ${hiddenCompletedCount}개 생략`));
    }

    for (const entry of visibleCompleted) {
      lines.push(formatProgressEntry(entry, now, innerWidth));
      if (entry.status === "failed" && entry.result) {
        lines.push(chalk.red(`  ${truncateText(entry.result.message, innerWidth - 2)}`));
      }
    }
  }

  lines.push("");
  lines.push(chalk.bold(`남은 작업 ${pendingEntries.length}개`));
  if (pendingEntries.length === 0) {
    lines.push(chalk.gray("  대기 중인 작업이 없습니다."));
  } else {
    const visiblePending = pendingEntries.slice(0, PROGRESS_LIST_LIMIT);
    for (const entry of visiblePending) {
      lines.push(formatProgressEntry(entry, now, innerWidth));
    }

    if (pendingEntries.length > visiblePending.length) {
      lines.push(chalk.gray(`  이후 작업 ${pendingEntries.length - visiblePending.length}개 더 있음`));
    }
  }

  return renderBoxLines(dryRun ? "tidymac dry-run 진행" : "tidymac clean 진행", lines, {
    color: failures > 0 ? chalk.yellow : dryRun ? chalk.cyan : chalk.green,
    width: boxWidth
  });
}

class CleanProgressRenderer {
  private readonly entries: ExecutionProgressEntry[];
  private readonly live: boolean;
  private readonly startedAt = Date.now();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lineCount = 0;
  private suspended = false;

  constructor(items: CleanableItem[], private readonly dryRun: boolean) {
    this.entries = items.map((item) => ({
      item,
      status: "pending"
    }));
    this.live = process.stdout.isTTY === true && process.env.CI !== "true";
  }

  start(): void {
    if (!this.live) {
      console.log(
        chalk.gray(
          `${this.dryRun ? "dry-run" : "clean"} 실행: ${this.entries.length}개 작업, 예상 회수 ${formatBytes(
            sumKnownBytes(this.entries.map((entry) => entry.item))
          )}`
        )
      );
      return;
    }

    process.stdout.write("\x1B[?25l");
    this.render();
    this.startTimer();
  }

  startItem(item: CleanableItem, options?: { silent?: boolean }): void {
    const entry = this.findEntry(item);
    entry.status = "running";
    entry.startedAt = Date.now();
    entry.finishedAt = undefined;
    entry.result = undefined;

    if (!this.live) {
      const index = this.entries.indexOf(entry) + 1;
      console.log(chalk.cyan(`[${index}/${this.entries.length}] 실행 중: ${item.label}`));
      return;
    }

    if (!this.suspended && options?.silent !== true) {
      this.render();
    }
  }

  finishItem(item: CleanableItem, result: ExecuteResult): void {
    const entry = this.findEntry(item);
    entry.status = result.success ? "success" : "failed";
    entry.result = result;
    entry.finishedAt = Date.now();

    if (!this.live) {
      const index = this.entries.indexOf(entry) + 1;
      const status = result.success ? chalk.green("완료") : chalk.red("실패");
      console.log(
        `${status} [${index}/${this.entries.length}] ${item.label}: ${result.message} ${chalk.gray(
          formatBytes(result.reclaimedBytes)
        )}`
      );
      return;
    }

    if (!this.suspended) {
      this.render();
    }
  }

  suspendForExternalPrompt(): void {
    if (!this.live || this.suspended) {
      return;
    }

    this.stopTimer();
    this.clearRendered();
    this.suspended = true;
    process.stdout.write("\x1B[?25h");
    console.log(chalk.yellow("sudo 권한 요청이 표시되면 터미널에서 승인/암호 입력을 완료하세요."));
  }

  resumeAfterExternalPrompt(): void {
    if (!this.live || !this.suspended) {
      return;
    }

    this.suspended = false;
    process.stdout.write("\x1B[?25l");
    this.render();
    this.startTimer();
  }

  stop(): void {
    if (!this.live) {
      return;
    }

    this.stopTimer();
    if (this.suspended) {
      this.suspended = false;
      process.stdout.write("\x1B[?25l");
    }
    this.render();
    process.stdout.write("\x1B[?25h");
  }

  private findEntry(item: CleanableItem): ExecutionProgressEntry {
    const entry = this.entries.find((candidate) => candidate.item.id === item.id);
    if (!entry) {
      throw new Error(`실행 진행 상태를 찾을 수 없습니다: ${item.id}`);
    }

    return entry;
  }

  private startTimer(): void {
    if (this.timer !== null) {
      return;
    }

    this.timer = setInterval(() => {
      this.render();
    }, PROGRESS_REFRESH_MS);
  }

  private stopTimer(): void {
    if (this.timer === null) {
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
  }

  private clearRendered(): void {
    for (let index = 0; index < this.lineCount; index += 1) {
      process.stdout.write("\x1B[1A\x1B[2K");
    }
    process.stdout.write("\r\x1B[2K");
    this.lineCount = 0;
  }

  private render(): void {
    if (!this.live || this.suspended) {
      return;
    }

    this.clearRendered();
    const lines = renderCleanProgress(this.entries, this.dryRun, this.startedAt, Date.now());
    process.stdout.write(`${lines.join("\n")}\n`);
    this.lineCount = lines.length;
  }
}

async function executeItems(items: CleanableItem[], dryRun: boolean): Promise<ExecutionRecord[]> {
  const records: ExecutionRecord[] = [];
  const historyEntries: HistoryEntry[] = [];
  const progress = new CleanProgressRenderer(items, dryRun);

  progress.start();
  try {
    for (const item of items) {
      const shouldSuspendForPrompt = item.requiresSudo && !dryRun;
      let result: ExecuteResult;

      progress.startItem(item, { silent: shouldSuspendForPrompt });

      if (shouldSuspendForPrompt) {
        progress.suspendForExternalPrompt();
      }

      try {
        result = await item.execute({ dryRun });
      } catch (error) {
        result = {
          success: false,
          reclaimedBytes: null,
          message: error instanceof Error ? error.message : String(error)
        };
      } finally {
        if (shouldSuspendForPrompt) {
          progress.resumeAfterExternalPrompt();
        }
      }

      progress.finishItem(item, result);
      records.push({ item, result });
      historyEntries.push(makeHistoryEntry(item, result, dryRun));
    }
  } finally {
    progress.stop();
  }

  try {
    await appendHistoryEntries(historyEntries);
  } catch (error) {
    console.warn(
      chalk.yellow(
        `히스토리 기록에 실패했습니다: ${error instanceof Error ? error.message : String(error)}`
      )
    );
  }

  return records;
}

function printExecutionSummary(records: ExecutionRecord[], dryRun: boolean): void {
  if (records.length === 0) {
    console.log(chalk.gray("실행한 항목이 없습니다."));
    return;
  }

  const label = dryRun ? "예상 회수" : "회수";
  printSpacer();
  const allResults = records.map((record) => record.result);
  const totalKnown = sumKnownBytes(allResults);
  const totalUnknown = countUnknownBytes(allResults);
  const lines: string[] = [
    `${chalk.gray("전체")} ${chalk.bold(formatBytes(totalKnown))}${
      totalUnknown > 0 ? chalk.gray(`   크기 미확정 ${totalUnknown}개`) : ""
    }`
  ];

  for (const category of CATEGORY_IDS) {
    const categoryRecords = records.filter((record) => record.item.category === category);
    if (categoryRecords.length === 0) {
      continue;
    }

    const knownTotal = sumKnownBytes(categoryRecords.map((record) => record.result));
    const unknownCount = countUnknownBytes(categoryRecords.map((record) => record.result));
    const failures = categoryRecords.filter((record) => !record.result.success).length;
    const ratio = totalKnown > 0 ? knownTotal / totalKnown : 0;

    lines.push(
      `${visiblePadEnd(CATEGORY_LABELS[category], 8)} ${renderNeutralGauge(ratio, {
        width: 18,
        color: failures > 0 ? chalk.red : chalk.cyan
      })} ${categoryRecords.length}개 / ${label} ${formatBytes(knownTotal)}${
        unknownCount > 0 ? chalk.gray(` / 크기 미확정 ${unknownCount}개`) : ""
      }${failures > 0 ? chalk.red(` / 실패 ${failures}개`) : ""}`
    );
  }

  printBox(dryRun ? "dry-run 결과" : "정리 결과", lines, {
    color: dryRun ? chalk.cyan : chalk.green
  });
}

async function handleScan(options: ScanOptions): Promise<void> {
  const category = parseCategory(options.category);
  const results = await scanCategories(category);
  printScanResults(results);
}

async function handleClean(options: CleanOptions): Promise<void> {
  const category = parseCategory(options.category);
  const dryRun = options.dryRun === true;
  const force = options.force === true;
  const results = await scanCategories(category);
  const items = flattenItems(results);

  if (items.length === 0) {
    console.log(chalk.green("정리 가능 항목이 없습니다."));
    return;
  }

  printScanResults(results);

  const selectedItems = await selectItems(items, force);
  if (selectedItems.length === 0) {
    console.log(chalk.gray("선택된 항목이 없습니다."));
    return;
  }

  if (!(await confirmRiskyItems(selectedItems, dryRun))) {
    console.log(chalk.gray("실행을 취소했습니다."));
    return;
  }

  console.log("");
  if (dryRun) {
    console.log(chalk.cyan("dry-run 모드: 실제 정리는 수행하지 않습니다."));
  }

  const records = await executeItems(selectedItems, dryRun);
  printExecutionSummary(records, dryRun);
}

function formatMaybeBytes(bytes: number | null): string {
  return bytes === null ? "확인 불가" : prettyBytes(bytes);
}

function parseMemoryFreeRatio(pressure: string | null): number | null {
  const match = pressure?.match(/System-wide memory free percentage:\s*(\d+)%/i);
  if (!match?.[1]) {
    return null;
  }

  const percent = Number.parseInt(match[1], 10);
  return Number.isFinite(percent) ? percent / 100 : null;
}

type DoctorStatus = "normal" | "caution" | "danger";

interface DoctorRatios {
  memoryUsedRatio: number | null;
  inactiveRatio: number | null;
  memoryFreeRatio: number | null;
  diskUsedRatio: number | null;
  diskAvailableRatio: number | null;
  cpuLoadRatios: [number, number, number];
}

interface DoctorRenderOptions {
  watch: boolean;
  intervalSeconds?: number;
  iteration?: number;
}

function doctorRatios(result: DoctorDiagnosis): DoctorRatios {
  const diskMeasuredBytes = result.disk ? result.disk.usedBytes + result.disk.availableBytes : null;
  const [oneMinute, fiveMinutes, fifteenMinutes] = result.cpu.loadAverage;

  return {
    memoryUsedRatio: ratioOrNull(result.memory.usedBytes, result.memory.totalBytes),
    inactiveRatio: ratioOrNull(result.memory.inactiveBytes, result.memory.totalBytes),
    memoryFreeRatio: parseMemoryFreeRatio(result.memory.pressure),
    diskUsedRatio: result.disk ? ratioOrNull(result.disk.usedBytes, diskMeasuredBytes) : null,
    diskAvailableRatio: result.disk ? ratioOrNull(result.disk.availableBytes, diskMeasuredBytes) : null,
    cpuLoadRatios: [
      oneMinute / result.cpu.cpuCount,
      fiveMinutes / result.cpu.cpuCount,
      fifteenMinutes / result.cpu.cpuCount
    ]
  };
}

function highRatioStatus(value: number | null, warnAt: number, dangerAt: number): DoctorStatus {
  if (value === null) {
    return "normal";
  }

  if (value >= dangerAt) {
    return "danger";
  }

  if (value >= warnAt) {
    return "caution";
  }

  return "normal";
}

function lowRatioStatus(value: number | null, warnBelow: number, dangerBelow: number): DoctorStatus {
  if (value === null) {
    return "normal";
  }

  if (value <= dangerBelow) {
    return "danger";
  }

  if (value <= warnBelow) {
    return "caution";
  }

  return "normal";
}

function worstDoctorStatus(statuses: DoctorStatus[]): DoctorStatus {
  if (statuses.includes("danger")) {
    return "danger";
  }

  if (statuses.includes("caution")) {
    return "caution";
  }

  return "normal";
}

function doctorStatus(result: DoctorDiagnosis, ratios: DoctorRatios): DoctorStatus {
  return worstDoctorStatus([
    highRatioStatus(ratios.memoryUsedRatio, 0.75, 0.9),
    lowRatioStatus(ratios.memoryFreeRatio, 0.25, 0.1),
    highRatioStatus(ratios.diskUsedRatio, 0.75, 0.9),
    lowRatioStatus(ratios.diskAvailableRatio, 0.2, 0.1),
    highRatioStatus(ratios.cpuLoadRatios[0], 0.7, 1),
    highRatioStatus(ratios.cpuLoadRatios[1], 0.7, 1),
    result.disk === null ? "caution" : "normal"
  ]);
}

function doctorStatusBadge(status: DoctorStatus): string {
  if (status === "danger") {
    return chalk.red("위험");
  }

  if (status === "caution") {
    return chalk.yellow("주의");
  }

  return chalk.green("정상");
}

function doctorStatusColor(status: DoctorStatus): ChalkInstance {
  if (status === "danger") {
    return chalk.red;
  }

  if (status === "caution") {
    return chalk.yellow;
  }

  return chalk.green;
}

function renderDoctorResult(result: DoctorDiagnosis, options: DoctorRenderOptions): void {
  const ratios = doctorRatios(result);
  const status = doctorStatus(result, ratios);
  const scannedAt = result.scannedAt.toLocaleString("ko-KR");
  const boxWidth = terminalWidth();
  const innerWidth = boxWidth - 4;

  printBox(
    "tidymac doctor",
    [
      `${chalk.gray("상태")} ${doctorStatusBadge(status)}   ${chalk.gray("갱신")} ${scannedAt}${
        options.watch && options.intervalSeconds ? chalk.gray(`   주기 ${options.intervalSeconds}초`) : ""
      }${options.watch && options.iteration ? chalk.gray(`   ${options.iteration}회차`) : ""}`,
      options.watch ? chalk.gray("Ctrl+C로 watch 모드를 종료합니다.") : chalk.gray("현재 시스템 상태 스냅샷입니다.")
    ],
    { color: doctorStatusColor(status), width: boxWidth }
  );

  printSpacer();
  printBox(
    `메모리 · 전체 ${formatMaybeBytes(result.memory.totalBytes)}`,
    [
      formatMetricLine("사용률", ratios.memoryUsedRatio, `${formatMaybeBytes(result.memory.usedBytes)} 사용 추정`, {
        warnAt: 0.75,
        dangerAt: 0.9
      }),
      formatMetricLine("비활성", ratios.inactiveRatio, `${formatMaybeBytes(result.memory.inactiveBytes)} purge 후보`, {
        warnAt: 0.5,
        dangerAt: 0.75
      }),
      formatMetricLine("여유율", ratios.memoryFreeRatio, "memory_pressure 기준", {
        availability: true,
        warnBelow: 0.25,
        dangerBelow: 0.1
      }),
      chalk.gray(
        truncateText(
          `세부 active ${formatMaybeBytes(result.memory.activeBytes)} / wired ${formatMaybeBytes(
            result.memory.wiredBytes
          )} / compressed ${formatMaybeBytes(result.memory.compressedBytes)}`,
          innerWidth
        )
      )
    ],
    { color: chalk.cyan, width: boxWidth }
  );

  printSpacer();
  if (result.disk) {
    printBox(
      "디스크 · /",
      [
        formatMetricLine(
          "사용률",
          ratios.diskUsedRatio,
          `${prettyBytes(result.disk.usedBytes)} 사용 / ${prettyBytes(result.disk.availableBytes)} 여유 (${result.disk.capacity})`,
          { warnAt: 0.75, dangerAt: 0.9 }
        ),
        formatMetricLine("여유율", ratios.diskAvailableRatio, `${prettyBytes(result.disk.availableBytes)} 여유`, {
          availability: true,
          warnBelow: 0.2,
          dangerBelow: 0.1
        })
      ],
      { color: chalk.cyan, width: boxWidth }
    );
  } else {
    printBox("디스크", [chalk.yellow("디스크 상태를 확인하지 못했습니다.")], {
      color: chalk.yellow,
      width: boxWidth
    });
  }

  printSpacer();
  printBox(
    `CPU · ${result.cpu.cpuCount}코어`,
    [
      formatMetricLine("1분", ratios.cpuLoadRatios[0], `loadavg ${result.cpu.loadAverage[0].toFixed(2)}`, {
        warnAt: 0.7,
        dangerAt: 1
      }),
      formatMetricLine("5분", ratios.cpuLoadRatios[1], `loadavg ${result.cpu.loadAverage[1].toFixed(2)}`, {
        warnAt: 0.7,
        dangerAt: 1
      }),
      formatMetricLine("15분", ratios.cpuLoadRatios[2], `loadavg ${result.cpu.loadAverage[2].toFixed(2)}`, {
        warnAt: 0.7,
        dangerAt: 1
      })
    ],
    { color: chalk.cyan, width: boxWidth }
  );
}

function parseDoctorIntervalSeconds(value: string | undefined): number {
  if (value === undefined) {
    return 5;
  }

  const interval = Number.parseFloat(value);
  if (!Number.isFinite(interval) || interval < 1) {
    throw new Error(`doctor 갱신 간격은 1초 이상의 숫자여야 합니다: ${value}`);
  }

  return interval;
}

function clearTerminalScreen(): void {
  process.stdout.write("\x1B[2J\x1B[H");
}

async function watchDoctor(intervalSeconds: number): Promise<void> {
  let running = true;
  let iteration = 0;
  let stopping = false;
  const abortController = new AbortController();

  const stop = (): void => {
    if (stopping) {
      return;
    }

    stopping = true;
    running = false;
    abortController.abort();
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.stdout.write("\x1B[?25l");

  try {
    while (running) {
      iteration += 1;
      clearTerminalScreen();

      try {
        const result = await diagnose();
        renderDoctorResult(result, {
          watch: true,
          intervalSeconds,
          iteration
        });
      } catch (error) {
        console.error(chalk.red(`시스템 상태 진단 실패: ${error instanceof Error ? error.message : String(error)}`));
      }

      if (!running) {
        break;
      }

      try {
        await sleep(intervalSeconds * 1000, undefined, { signal: abortController.signal });
      } catch {
        break;
      }
    }
  } finally {
    process.stdout.write("\x1B[?25h");
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    process.exitCode = 0;
    console.log("");
    console.log(chalk.gray("doctor watch 모드를 종료했습니다."));
  }
}

async function handleDoctor(options: DoctorOptions): Promise<void> {
  const intervalSeconds = parseDoctorIntervalSeconds(options.interval);
  const watch = options.watch === true || options.interval !== undefined;

  if (watch) {
    await watchDoctor(intervalSeconds);
    return;
  }

  const spinner = ora("시스템 상태 진단 중...").start();
  try {
    const result = await diagnose();
    spinner.succeed("시스템 상태 진단 완료");

    console.log("");
    renderDoctorResult(result, { watch: false });
  } catch (error) {
    spinner.fail("시스템 상태 진단 실패");
    throw error;
  }
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) {
    return 20;
  }

  const limit = Number.parseInt(value, 10);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error(`limit은 양의 정수여야 합니다: ${value}`);
  }

  return limit;
}

async function handleHistory(options: HistoryOptions): Promise<void> {
  const limit = parseLimit(options.limit);
  const entries = await readHistory(limit);

  if (entries.length === 0) {
    console.log(chalk.gray("정리 이력이 없습니다."));
    return;
  }

  console.log(chalk.bold(`최근 정리 이력 ${entries.length}개`));
  for (const entry of entries) {
    const executedAt = new Date(entry.executedAt).toLocaleString("ko-KR");
    const mode = entry.dryRun ? chalk.cyan("dry-run") : "실행";
    const status = entry.success ? chalk.green("성공") : chalk.red("실패");
    console.log(
      `${executedAt} ${mode} ${status} ${categoryBadge(entry.category)} ${riskBadge(entry.risk)} ${
        entry.requiresSudo ? `${chalk.magenta("[sudo]")} ` : ""
      }${entry.label} ${chalk.gray(formatBytes(entry.reclaimedBytes))}`
    );
    console.log(`  ${chalk.gray(entry.message)}`);
  }
}

async function main(): Promise<void> {
  ensureDarwin();

  const program = new Command();
  program
    .name("tidymac")
    .description("macOS 개발 워크플로를 위한 시스템 리소스 스캔 및 정리 CLI")
    .helpOption("-h, --help", "도움말을 표시합니다.")
    .addHelpCommand("help [명령어]", "명령어 도움말을 표시합니다.")
    .configureHelp({
      formatHelp: formatHelpKorean
    })
    .configureOutput({
      writeErr: (message) => process.stderr.write(localizeCommanderError(message))
    })
    .version("0.1.0", "-V, --version", "버전을 표시합니다.");

  program
    .command("scan")
    .description("정리 가능 리소스를 스캔합니다. 실제 정리는 수행하지 않습니다.")
    .option("--category <카테고리>", `카테고리 선택 (${CATEGORY_IDS.join(", ")})`)
    .action((options: ScanOptions) => handleScan(options));

  program
    .command("clean")
    .description("인터랙티브하게 리소스를 정리합니다.")
    .option("--category <카테고리>", `카테고리 선택 (${CATEGORY_IDS.join(", ")})`)
    .option("--dry-run", "시뮬레이션만 수행합니다.")
    .option("--force", "안전 항목을 확인 없이 자동 정리합니다.")
    .action((options: CleanOptions) => handleClean(options));

  program
    .command("doctor")
    .description("메모리, 디스크, CPU 상태를 진단합니다.")
    .option("--watch", "일정 간격으로 상태를 갱신합니다.")
    .option("--interval <초>", "watch 모드 갱신 간격입니다. 기본값은 5초입니다.")
    .action((options: DoctorOptions) => handleDoctor(options));

  program
    .command("history")
    .description("정리 이력을 조회합니다.")
    .option("--limit <개수>", "조회할 최근 이력 개수", "20")
    .action((options: HistoryOptions) => handleHistory(options));

  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  console.error(chalk.red(error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
