import { chmodSync, lstatSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** The eight operational modules exposed by /admin and the health document. */
export const MODULE_STATUS_NAMES = [
  "ai",
  "voice",
  "steam-free",
  "database",
  "9router",
  "backup",
  "key-sync",
  "discord"
] as const;

export type ModuleStatusName = (typeof MODULE_STATUS_NAMES)[number];
export type ModuleStatusState = "ready" | "disabled" | "degraded";

export const MODULE_STATUS_LABELS: Record<ModuleStatusName, string> = {
  ai: "AI",
  voice: "動態語音",
  "steam-free": "Steam 免費遊戲",
  database: "資料庫",
  "9router": "9router",
  backup: "備份",
  "key-sync": "Key 同步",
  discord: "Discord"
};

export const MODULE_STATUS_STALE_AFTER_MS: Record<ModuleStatusName, number> = {
  ai: 3 * 60 * 1000,
  voice: 3 * 60 * 1000,
  "steam-free": 3 * 60 * 1000,
  database: 3 * 60 * 1000,
  "9router": 3 * 60 * 1000,
  backup: 26 * 60 * 60 * 1000,
  "key-sync": 3 * 60 * 1000,
  discord: 3 * 60 * 1000
};

/** Fixed contract shared by in-memory health and external status files. */
export type ModuleStatus = {
  module: ModuleStatusName;
  state: ModuleStatusState;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  errorCode: string | null;
};

export type ModuleStatusInput = {
  state: ModuleStatusState;
  lastSuccessAt?: string | null;
  lastErrorAt?: string | null;
  errorCode?: string | null;
};

function validTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function statusIsStale(status: ModuleStatus, now: number): boolean {
  const heartbeat = status.lastSuccessAt ?? status.lastErrorAt;
  const timestamp = Date.parse(heartbeat ?? "");
  return !Number.isFinite(timestamp) || now - timestamp > MODULE_STATUS_STALE_AFTER_MS[status.module];
}

/** Process-local status registry; every process starts degraded until heartbeats arrive. */
export class ModuleStatusRegistry {
  private readonly statuses = new Map<ModuleStatusName, ModuleStatus>();
  private readonly clock: () => number;

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
    for (const module of MODULE_STATUS_NAMES) {
      this.statuses.set(module, {
        module,
        state: "degraded",
        lastSuccessAt: null,
        lastErrorAt: null,
        errorCode: "MODULE-INIT-001"
      });
    }
  }

  set(module: ModuleStatusName, input: ModuleStatusInput): ModuleStatus {
    const existing = this.statuses.get(module);
    const now = new Date(this.clock()).toISOString();
    const lastSuccessAt = input.lastSuccessAt !== undefined
      ? validTimestamp(input.lastSuccessAt)
      : input.state === "ready" ? now : existing?.lastSuccessAt ?? null;
    const lastErrorAt = input.lastErrorAt !== undefined
      ? validTimestamp(input.lastErrorAt)
      : input.state === "degraded" ? now : existing?.lastErrorAt ?? null;
    const errorCode = input.errorCode !== undefined
      ? (input.errorCode ? input.errorCode.slice(0, 80) : null)
      : (input.state === "ready" || input.state === "disabled" ? null : existing?.errorCode ?? null);
    const next: ModuleStatus = { module, state: input.state, lastSuccessAt, lastErrorAt, errorCode };
    this.statuses.set(module, next);
    return { ...next };
  }

  get(module: ModuleStatusName, now = this.clock()): ModuleStatus {
    const status = this.statuses.get(module) ?? this.set(module, { state: "degraded", errorCode: "MODULE-INIT-001" });
    return this.withStale(status, now);
  }

  snapshot(now = this.clock()): ModuleStatus[] {
    return MODULE_STATUS_NAMES.map((module) => this.get(module, now));
  }

  asObject(now = this.clock()): Record<ModuleStatusName, ModuleStatus> {
    return Object.fromEntries(this.snapshot(now).map((status) => [status.module, status])) as Record<ModuleStatusName, ModuleStatus>;
  }

  private withStale(status: ModuleStatus, now: number): ModuleStatus {
    if (!statusIsStale(status, now) || status.state === "disabled") return { ...status };
    return { ...status, state: "degraded", errorCode: status.errorCode ?? "MODULE-STALE-001" };
  }
}

export const moduleStatusRegistry = new ModuleStatusRegistry();

/** Reject symlinked status paths while allowing not-yet-created leaf files. */
function assertSafePathTree(path: string, requireDirectory = false): void {
  const absolute = resolve(path);
  let current = absolute;
  while (true) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error("status_path_symlink");
      if ((current !== absolute || requireDirectory) && !stat.isDirectory()) {
        throw new Error("status_path_not_directory");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/** Atomically replace a JSON status file and keep it owner-readable only. */
export function atomicWriteJson(path: string, value: unknown, mode = 0o600): void {
  const parent = dirname(path);
  assertSafePathTree(parent, true);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  assertSafePathTree(parent, true);
  chmodSync(parent, 0o700);
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    assertSafePathTree(path);
    assertSafePathTree(temporaryPath);
    writeFileSync(temporaryPath, JSON.stringify(value) + "\n", { encoding: "utf8", mode });
    chmodSync(temporaryPath, mode);
    renameSync(temporaryPath, path);
    chmodSync(path, mode);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch { /* preserve original error */ }
    throw error;
  }
}

export function moduleStatusHealth(now = Date.now()): {
  timestamp: number;
  modules: Record<ModuleStatusName, ModuleStatus>;
} {
  return { timestamp: now, modules: moduleStatusRegistry.asObject(now) };
}
