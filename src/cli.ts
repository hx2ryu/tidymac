#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { platform } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import chalk, { type ChalkInstance } from "chalk";
import { Command, type Help } from "commander";
import inquirer from "inquirer";
import ora from "ora";
import prettyBytes from "pretty-bytes";
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

function padLabel(label: string, width: number): string {
  return label.length >= width ? label : label.padEnd(width);
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

function ratioOrNull(used: number | null, total: number | null): number | null {
  if (used === null || total === null || total <= 0) {
    return null;
  }

  return used / total;
}

function renderMetricLine(
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
): void {
  const labelText = padLabel(label, 10);
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
  console.log(`  ${labelText} ${gauge} ${percent.padStart(4)}  ${detail}`);
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

function printRiskDistribution(items: CleanableItem[]): void {
  const total = items.length;
  const counts = countByRisk(items);

  if (total === 0) {
    return;
  }

  console.log(chalk.bold("위험도 분포"));
  for (const risk of ["safe", "caution", "danger"] as const) {
    const count = counts[risk];
    const ratio = count / total;
    console.log(
      `  ${padLabel(RISK_LABELS[risk], 4)} ${renderNeutralGauge(ratio, {
        width: 18,
        color: RISK_COLORS[risk]
      })} ${count}개`
    );
  }
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

  console.log("");
  console.log(chalk.bold("스캔 결과"));
  const totalKnown = sumKnownBytes(allItems);
  const totalUnknown = countUnknownBytes(allItems);

  console.log(
    `${chalk.bold("전체 예상 회수")} ${formatBytes(totalKnown)}${
      totalUnknown > 0 ? chalk.gray(` / 크기 미확정 ${totalUnknown}개`) : ""
    }`
  );
  printRiskDistribution(allItems);

  for (const result of results) {
    if (result.items.length === 0) {
      continue;
    }

    const knownTotal = sumKnownBytes(result.items);
    const unknownCount = countUnknownBytes(result.items);
    const categoryRatio = totalKnown > 0 ? knownTotal / totalKnown : 0;
    console.log("");
    console.log(
      `${categoryBadge(result.category)} ${renderNeutralGauge(categoryRatio, {
        width: 18,
        color: chalk.cyan
      })} ${result.items.length}개 / 예상 회수 ${formatBytes(knownTotal)}${
        unknownCount > 0 ? chalk.gray(` / 크기 미확정 ${unknownCount}개`) : ""
      }`
    );

    for (const item of result.items) {
      const itemRatio = knownTotal > 0 && item.reclaimableBytes !== null ? item.reclaimableBytes / knownTotal : 0;
      const gauge =
        item.reclaimableBytes === null
          ? renderUnknownGauge(12)
          : renderNeutralGauge(itemRatio, { width: 12, color: RISK_COLORS[item.risk] });
      console.log(
        `  ${gauge} ${riskBadge(item.risk)} ${sudoBadge(item)}${chalk.bold(item.label)} ${chalk.gray(
          formatBytes(item.reclaimableBytes)
        )}`
      );
      console.log(`    ${chalk.gray(item.description)}`);
    }
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

async function executeItems(items: CleanableItem[], dryRun: boolean): Promise<ExecutionRecord[]> {
  const records: ExecutionRecord[] = [];
  const historyEntries: HistoryEntry[] = [];

  for (const item of items) {
    const spinner = ora(`${item.label} 실행 중...`).start();
    let result: ExecuteResult;

    try {
      result = await item.execute({ dryRun });
    } catch (error) {
      result = {
        success: false,
        reclaimedBytes: null,
        message: error instanceof Error ? error.message : String(error)
      };
    }

    if (result.success) {
      spinner.succeed(`${item.label}: ${result.message}`);
    } else {
      spinner.fail(`${item.label}: ${result.message}`);
    }

    records.push({ item, result });
    historyEntries.push(makeHistoryEntry(item, result, dryRun));
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
  console.log("");
  console.log(chalk.bold(dryRun ? "Dry-run 결과" : "정리 결과"));
  const allResults = records.map((record) => record.result);
  const totalKnown = sumKnownBytes(allResults);
  const totalUnknown = countUnknownBytes(allResults);

  for (const category of CATEGORY_IDS) {
    const categoryRecords = records.filter((record) => record.item.category === category);
    if (categoryRecords.length === 0) {
      continue;
    }

    const knownTotal = sumKnownBytes(categoryRecords.map((record) => record.result));
    const unknownCount = countUnknownBytes(categoryRecords.map((record) => record.result));
    const failures = categoryRecords.filter((record) => !record.result.success).length;
    const ratio = totalKnown > 0 ? knownTotal / totalKnown : 0;

    console.log(
      `${categoryBadge(category)} ${renderNeutralGauge(ratio, {
        width: 18,
        color: failures > 0 ? chalk.red : chalk.cyan
      })} ${categoryRecords.length}개 / ${label} ${formatBytes(knownTotal)}${
        unknownCount > 0 ? chalk.gray(` / 크기 미확정 ${unknownCount}개`) : ""
      }${failures > 0 ? chalk.red(` / 실패 ${failures}개`) : ""}`
    );
  }

  console.log(`${chalk.bold(`전체 ${label}`)}: ${formatBytes(totalKnown)}`);
  if (totalUnknown > 0) {
    console.log(chalk.gray(`크기 미확정 항목 ${totalUnknown}개가 별도로 있습니다.`));
  }
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

function renderDoctorResult(result: DoctorDiagnosis, options: DoctorRenderOptions): void {
  const ratios = doctorRatios(result);
  const status = doctorStatus(result, ratios);
  const scannedAt = result.scannedAt.toLocaleString("ko-KR");

  console.log(chalk.bold("시스템 진단"));
  console.log(
    `${chalk.bold("상태")} ${doctorStatusBadge(status)} ${chalk.gray(`/ 갱신 ${scannedAt}`)}${
      options.watch && options.intervalSeconds
        ? chalk.gray(` / ${options.intervalSeconds}초 간격 / Ctrl+C 종료`)
        : ""
    }${options.watch && options.iteration ? chalk.gray(` / ${options.iteration}회차`) : ""}`
  );
  console.log("");

  console.log(`${chalk.cyan("[메모리]")} 전체 ${formatMaybeBytes(result.memory.totalBytes)}`);
  renderMetricLine(
    "사용률",
    ratios.memoryUsedRatio,
    `${formatMaybeBytes(result.memory.usedBytes)} 사용 추정`,
    { warnAt: 0.75, dangerAt: 0.9 }
  );
  renderMetricLine(
    "비활성",
    ratios.inactiveRatio,
    `${formatMaybeBytes(result.memory.inactiveBytes)} purge 후보`,
    { warnAt: 0.5, dangerAt: 0.75 }
  );
  renderMetricLine(
    "여유율",
    ratios.memoryFreeRatio,
    "memory_pressure 기준",
    { availability: true, warnBelow: 0.25, dangerBelow: 0.1 }
  );
  console.log(
    `  ${chalk.gray("세부")} active ${formatMaybeBytes(result.memory.activeBytes)} / wired ${formatMaybeBytes(
      result.memory.wiredBytes
    )} / compressed ${formatMaybeBytes(result.memory.compressedBytes)}`
  );

  if (result.disk) {
    console.log(`${chalk.cyan("[디스크]")} /`);
    renderMetricLine(
      "사용률",
      ratios.diskUsedRatio,
      `${prettyBytes(result.disk.usedBytes)} 사용 / ${prettyBytes(result.disk.availableBytes)} 여유 (${result.disk.capacity})`,
      { warnAt: 0.75, dangerAt: 0.9 }
    );
    renderMetricLine(
      "여유율",
      ratios.diskAvailableRatio,
      `${prettyBytes(result.disk.availableBytes)} 여유`,
      { availability: true, warnBelow: 0.2, dangerBelow: 0.1 }
    );
  } else {
    console.log(`${chalk.cyan("[디스크]")} 확인 불가`);
  }

  console.log(`${chalk.cyan("[CPU]")} 코어 ${result.cpu.cpuCount}개`);
  renderMetricLine(
    "1분",
    ratios.cpuLoadRatios[0],
    `loadavg ${result.cpu.loadAverage[0].toFixed(2)}`,
    { warnAt: 0.7, dangerAt: 1 }
  );
  renderMetricLine(
    "5분",
    ratios.cpuLoadRatios[1],
    `loadavg ${result.cpu.loadAverage[1].toFixed(2)}`,
    { warnAt: 0.7, dangerAt: 1 }
  );
  renderMetricLine(
    "15분",
    ratios.cpuLoadRatios[2],
    `loadavg ${result.cpu.loadAverage[2].toFixed(2)}`,
    { warnAt: 0.7, dangerAt: 1 }
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
  const abortController = new AbortController();

  const stop = (): void => {
    running = false;
    abortController.abort();
  };

  process.once("SIGINT", stop);
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
