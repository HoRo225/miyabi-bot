import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type NineRouterKey = { id: string; name: string; createdAt: string };
export type NineRouterKeyState = { keys: NineRouterKey[]; appliedId: string; updatedAt: string; overflow: boolean };

const KEY_ID = /^[0-9a-f-]{36}$/i;

export function readNineRouterKeyState(databasePath: string, metadataPath = join(dirname(databasePath), "9router-api-keys.json")): NineRouterKeyState {
  try {
    const value = JSON.parse(readFileSync(metadataPath, "utf8")) as { keys?: unknown; appliedId?: unknown; updatedAt?: unknown };
    const seen = new Set<string>();
    const keys = (Array.isArray(value.keys) ? value.keys : []).flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      const id = typeof row.id === "string" ? row.id.trim() : "";
      const name = typeof row.name === "string" ? row.name.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80) : "";
      const createdAt = typeof row.createdAt === "string" ? row.createdAt.slice(0, 40) : "";
      if (!KEY_ID.test(id) || !name || seen.has(id)) return [];
      seen.add(id);
      return [{ id, name, createdAt }];
    });
    const appliedId = typeof value.appliedId === "string" && keys.some((key) => key.id === value.appliedId) ? value.appliedId : "";
    return { keys: keys.slice(0, 26), appliedId, updatedAt: typeof value.updatedAt === "string" ? value.updatedAt.slice(0, 40) : "", overflow: keys.length > 25 };
  } catch {
    return { keys: [], appliedId: "", updatedAt: "", overflow: false };
  }
}

export function nineRouterKeyOptions(state: NineRouterKeyState, selectedId: string) {
  const selected = selectedId || state.appliedId;
  return [...state.keys]
    .sort((a, b) => Number(b.id === selected) - Number(a.id === selected))
    .slice(0, 25)
    .map((key) => ({
      label: `${key.name} · ${key.id.slice(0, 8)}`,
      value: key.id,
      description: key.id === state.appliedId ? "目前套用" : key.id === selected ? "已選擇，等待套用" : "可用"
    }));
}
