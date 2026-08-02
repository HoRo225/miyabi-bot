import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MODULE_STATUS_NAMES,
  ModuleStatusRegistry,
  atomicWriteJson
} from "./module-status.js";

test("module status registry exposes eight modules and degrades stale heartbeats", () => {
  assert.equal(MODULE_STATUS_NAMES.length, 8);
  const registry = new ModuleStatusRegistry(() => 1_000);
  registry.set("backup", { state: "ready", lastSuccessAt: new Date(1_000).toISOString() });
  const snapshot = registry.snapshot(26 * 60 * 60 * 1000 + 1_001);
  assert.equal(snapshot.find((status) => status.module === "backup")?.state, "degraded");
  registry.set("ai", { state: "disabled", lastSuccessAt: new Date(1_000).toISOString() });
  assert.equal(registry.get("ai", 26 * 60 * 60 * 1000 + 1_001).state, "disabled");
});

test("atomic status JSON is mode 600 and has no partial files", () => {
  const dir = mkdtempSync(join(tmpdir(), "horo-module-status-"));
  try {
    const path = join(dir, "status.json");
    const status = {
      module: "backup",
      state: "ready",
      lastSuccessAt: "2026-08-02T00:00:00.000Z",
      lastErrorAt: null,
      errorCode: null
    };
    atomicWriteJson(path, status);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(parsed, status);
    assert.deepEqual(Object.keys(parsed).sort(), [
      "errorCode",
      "lastErrorAt",
      "lastSuccessAt",
      "module",
      "state"
    ]);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir).filter((name) => name.includes(".tmp-")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("atomic status JSON rejects a symlinked parent without creating a temp file", () => {
  const dir = mkdtempSync(join(tmpdir(), "horo-module-status-parent-"));
  const outside = mkdtempSync(join(tmpdir(), "horo-module-status-outside-"));
  try {
    const linkedParent = join(dir, "status");
    symlinkSync(outside, linkedParent, "dir");
    assert.throws(
      () => atomicWriteJson(join(linkedParent, "status.json"), { module: "backup" }),
      /status_path_symlink/
    );
    assert.deepEqual(readdirSync(outside), []);
    assert.deepEqual(readdirSync(dir).filter((name) => name.includes(".tmp-")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("atomic status JSON rejects a symlinked target and preserves its referent", () => {
  const dir = mkdtempSync(join(tmpdir(), "horo-module-status-target-"));
  try {
    const referent = join(dir, "referent.json");
    const target = join(dir, "status.json");
    writeFileSync(referent, "sentinel\n", "utf8");
    symlinkSync(referent, target, "file");
    assert.throws(
      () => atomicWriteJson(target, { module: "backup" }),
      /status_path_symlink/
    );
    assert.equal(readFileSync(referent, "utf8"), "sentinel\n");
    assert.deepEqual(readdirSync(dir).filter((name) => name.includes(".tmp-")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
