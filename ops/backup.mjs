import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

const databasePath = process.env.DATABASE_PATH ?? "/app/data/bot.sqlite";
const backupDir = process.env.BACKUP_DIR ?? "/backups";
const statusDir = process.env.STATUS_DIR ?? "/app/data/status";
const statusPath = process.env.STATUS_PATH ?? join(statusDir, "backup.json");
const keep = Math.max(1, Number.parseInt(process.env.BACKUP_KEEP ?? "7", 10) || 7);
const backupErrorCode = "BACKUP-001";

const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replaceAll(/[-:]/g, "");
const target = join(backupDir, `bot-${timestamp}.sqlite`);
const partial = `${target}.partial`;
const partialSidecars = [`${partial}-wal`, `${partial}-shm`];

async function assertSafePathTree(path, requireDirectory = false) {
  const absolute = resolve(path);
  let current = absolute;
  while (true) {
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error("backup_path_symlink");
      if ((current !== absolute || requireDirectory) && !stat.isDirectory()) {
        throw new Error("backup_path_not_directory");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function removePartialFiles() {
  await Promise.all([partial, ...partialSidecars].map((path) => rm(path, { force: true })));
}

async function previousStatus() {
  try {
    const parsed = JSON.parse(await readFile(statusPath, "utf8"));
    return {
      lastSuccessAt: typeof parsed.lastSuccessAt === "string" ? parsed.lastSuccessAt : null,
      lastErrorAt: typeof parsed.lastErrorAt === "string" ? parsed.lastErrorAt : null,
    };
  } catch {
    return { lastSuccessAt: null, lastErrorAt: null };
  }
}

async function writeStatus(state) {
  await assertSafePathTree(statusDir, true);
  await mkdir(statusDir, { recursive: true, mode: 0o700 });
  await assertSafePathTree(statusDir, true);
  await chmod(statusDir, 0o700);
  const temporary = `${statusPath}.${process.pid}.tmp`;
  try {
    await assertSafePathTree(statusPath);
    await assertSafePathTree(temporary);
    const prior = await previousStatus();
    const now = new Date().toISOString();
    const status = {
      module: "backup",
      state,
      lastSuccessAt: state === "ready" ? now : prior.lastSuccessAt,
      lastErrorAt: state === "degraded" ? now : prior.lastErrorAt,
      errorCode: state === "degraded" ? backupErrorCode : null,
    };
    await writeFile(temporary, `${JSON.stringify(status)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, statusPath);
    await chmod(statusPath, 0o600);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function createBackup() {
  await assertSafePathTree(backupDir, true);
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  await assertSafePathTree(backupDir, true);
  await chmod(backupDir, 0o700);
  await assertSafePathTree(target);
  await assertSafePathTree(partial);
  await removePartialFiles();

  try {
    const source = new DatabaseSync(databasePath, { readOnly: true, timeout: 30_000 });
    try {
      await backup(source, partial);
    } finally {
      source.close();
    }

    const copy = new DatabaseSync(partial, { readOnly: true, timeout: 30_000 });
    try {
      const integrity = copy.prepare("PRAGMA integrity_check").get();
      const foreignKeys = copy.prepare("PRAGMA foreign_key_check").all();
      if (integrity?.integrity_check !== "ok" || foreignKeys.length !== 0) {
        throw new Error("backup verification failed");
      }
    } finally {
      copy.close();
    }

    await Promise.all(partialSidecars.map((path) => rm(path, { force: true })));
    await chmod(partial, 0o600);
    await rename(partial, target);
  } catch (error) {
    await removePartialFiles().catch(() => undefined);
    throw error;
  }

  const backups = (await readdir(backupDir))
    .filter((name) => /^bot-\d{8}T\d{6}Z\.sqlite$/.test(name))
    .sort()
    .reverse();
  await Promise.all(backups.slice(keep).map((name) => rm(join(backupDir, name), { force: true })));
  return `/backups/${basename(target)}`;
}

try {
  await assertSafePathTree(statusDir, true);
  await assertSafePathTree(statusPath);
  const output = await createBackup();
  await writeStatus("ready");
  console.log(output);
} catch {
  await writeStatus("degraded").catch(() => undefined);
  console.error("backup failed");
  process.exitCode = 1;
}
