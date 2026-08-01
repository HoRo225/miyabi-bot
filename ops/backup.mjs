import { chmod, mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

const databasePath = process.env.DATABASE_PATH ?? "/app/data/bot.sqlite";
const backupDir = process.env.BACKUP_DIR ?? "/backups";
const keep = Math.max(1, Number.parseInt(process.env.BACKUP_KEEP ?? "14", 10) || 14);
const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replaceAll(/[-:]/g, "");
const target = join(backupDir, `bot-${timestamp}.sqlite`);
const partial = `${target}.partial`;
const partialSidecars = [`${partial}-wal`, `${partial}-shm`];

await mkdir(backupDir, { recursive: true, mode: 0o700 });
await chmod(backupDir, 0o700);
await Promise.all([partial, ...partialSidecars].map((path) => rm(path, { force: true })));

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
  await Promise.all([partial, ...partialSidecars].map((path) => rm(path, { force: true })));
  throw error;
}

const backups = (await readdir(backupDir))
  .filter((name) => /^bot-\d{8}T\d{6}Z\.sqlite$/.test(name))
  .sort()
  .reverse();
await Promise.all(backups.slice(keep).map((name) => rm(join(backupDir, name), { force: true })));

console.log(`/backups/${basename(target)}`);
