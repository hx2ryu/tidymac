export type RiskLevel = "safe" | "caution" | "danger";

export type CategoryId = "memory" | "disk" | "cpu" | "network";

export interface CleanableItem {
  id: string;
  category: CategoryId;
  label: string;
  description: string;
  risk: RiskLevel;
  reclaimableBytes: number | null;
  requiresSudo: boolean;
  meta?: Record<string, unknown>;
  execute: (opts: { dryRun: boolean }) => Promise<ExecuteResult>;
}

export interface ExecuteResult {
  success: boolean;
  reclaimedBytes: number | null;
  message: string;
}

export interface ScanResult {
  category: CategoryId;
  items: CleanableItem[];
  scannedAt: Date;
}

export interface HistoryEntry {
  id: string;
  executedAt: string;
  category: CategoryId;
  itemId: string;
  label: string;
  risk: RiskLevel;
  requiresSudo: boolean;
  dryRun: boolean;
  success: boolean;
  reclaimedBytes: number | null;
  message: string;
}

export interface MemoryDiagnosis {
  totalBytes: number | null;
  pageSizeBytes: number | null;
  activeBytes: number | null;
  wiredBytes: number | null;
  compressedBytes: number | null;
  inactiveBytes: number | null;
  usedBytes: number | null;
  pressure: string | null;
}

export interface DiskDiagnosis {
  filesystem: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  capacity: string;
  mount: string;
}

export interface CpuDiagnosis {
  loadAverage: [number, number, number];
  cpuCount: number;
}

export interface DoctorDiagnosis {
  scannedAt: Date;
  memory: MemoryDiagnosis;
  disk: DiskDiagnosis | null;
  cpu: CpuDiagnosis;
}
