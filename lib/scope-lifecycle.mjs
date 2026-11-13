import { one, run } from "./db.mjs";
import fs from "node:fs";
import path from "node:path";
import { paths } from "./paths.mjs";

const removingCharacters = new Set();
export const characterRemovalInProgress = id => removingCharacters.has(id);
export function setCharacterRemoval(id, removing) {
  if (removing) removingCharacters.add(id); else removingCharacters.delete(id);
}

// A character can share a QQ scope with another character. Its own generation
// cancels stale work without invalidating the other character's pending work.
export function characterGeneration(id) {
  return Number(one("select value from meta where key=?", ["character-generation:" + id])?.value) || 0;
}
export function invalidateCharacter(id) {
  const generation = characterGeneration(id) + 1;
  run("insert or replace into meta(key,value) values(?,?)", ["character-generation:" + id, String(generation)]);
  return generation;
}
export function isCurrentCharacter(id, generation) {
  if (!id) return true;
  if (characterRemovalInProgress(id)) return false;
  const current = characterGeneration(id);
  return current === generation && (!current || fs.existsSync(path.join(paths.characters, id + ".json")));
}
export function assertCurrentCharacter(id, generation) {
  if (!isCurrentCharacter(id, generation)) throw Object.assign(new Error("角色已删除，旧任务已丢弃"), { kind: "scope_cleared" });
}

export function scopeState(key) {
  if (!String(key ?? "").trim()) throw new Error("作用域键不能为空");
  return one("select generation, cleared_at from scope_resets where scope_key = ?", [key]) ?? { generation: 0, cleared_at: 0 };
}

export function scopeGeneration(key) { return Number(scopeState(key).generation); }
export function isCurrentScope(key, generation) { return scopeGeneration(key) === generation; }
export function assertCurrentScope(key, generation) {
  if (!isCurrentScope(key, generation)) throw Object.assign(new Error("会话已清空，旧任务已丢弃"), { kind: "scope_cleared" });
}

// Sends already handed to the protocol cannot be recalled. Clear waits for those
// sends, while generation checks prevent any further old sends or write-backs.
const sends = new Set();
export async function trackScopeSend(keys, send) {
  const entry = { keys: new Set(keys), promise: null };
  entry.promise = Promise.resolve().then(send);
  sends.add(entry);
  try { return await entry.promise; } finally { sends.delete(entry); }
}
export async function drainScopeSends(key) {
  await Promise.allSettled([...sends].filter((entry) => entry.keys.has(key)).map((entry) => entry.promise));
}
