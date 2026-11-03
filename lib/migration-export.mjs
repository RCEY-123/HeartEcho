import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { paths } from "./paths.mjs";
import { getConfig } from "./config.mjs";

export function withoutCredentials(value) {
  if (Array.isArray(value)) return value.map(withoutCredentials);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /api.?key|access.?token|^token$|authorization|password|secret|consentDigest/i.test(key) ? "" : withoutCredentials(item)]));
}

// 同步复制和 SQLite 自包含快照在同一事件循环内完成，避免复制中的 JS 写入。
// 外部 Hindsight 服务/容器不属于此目录；本地记忆原文和同步记录在 main.db 中。
export function exportMigration() {
  const output = path.join(paths.exports, "migration-" + new Date().toISOString().replace(/[:.]/g, "-") + "-" + Math.random().toString(36).slice(2, 8), "data-export");
  fs.mkdirSync(output, { recursive: true });
  function copy(from, to) {
    const info = fs.lstatSync(from);
    if (info.isSymbolicLink()) throw new Error("数据含链接，请先检查后再导出");
    if (info.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      for (const name of fs.readdirSync(from)) {
        if (/^(updates\.json|update-install\.json|hindsight-runtime.*|panel-token|.*\.lock)$/i.test(name)) continue;
        copy(path.join(from, name), path.join(to, name));
      }
    } else if (info.isFile()) {
      if (from.endsWith(".json")) {
        const value = JSON.parse(fs.readFileSync(from, "utf8").replace(/^\uFEFF/, ""));
        fs.writeFileSync(to, JSON.stringify(withoutCredentials(value), null, 2));
      } else fs.copyFileSync(from, to);
    } else throw new Error("数据包含不支持的文件类型");
  }
  try {
    for (const name of ["characters", "media", "state"]) {
      const source = path.join(paths.data, name);
      if (fs.existsSync(source)) copy(source, path.join(output, name));
    }
    const config = withoutCredentials(getConfig());
    config.onboarding = { done: false, completedAt: 0, steps: {} };
    if (config.nextMemory) { config.nextMemory.enabled = false; config.nextMemory.managed = false; }
    fs.writeFileSync(path.join(output, "config.json"), JSON.stringify(config, null, 2));
    fs.mkdirSync(path.join(output, "database"));
    const db = new DatabaseSync(paths.mainDb, { readOnly: true });
    try { db.exec("VACUUM INTO '" + path.join(output, "database", "main.db").replace(/'/g, "''") + "'"); }
    finally { db.close(); }
    fs.writeFileSync(path.join(output, "迁移说明.txt"), "请妥善保管：含私人角色、对话、记忆和生命计划，不要公开上传。\r\n安装新版时勾选导入旧数据，选择此文件夹。原API Key和服务授权不随导出携带，请在新设备重新接入。\r\n外部Hindsight服务或Docker卷不在此导出中；本地原文保留，迁移后重新开启记忆并确认服务配置。\r\n每个独立实例须分别导出。\r\n");
    return { ok: true, directory: output };
  } catch (error) {
    fs.rmSync(path.dirname(output), { recursive: true, force: true });
    throw error;
  }
}
