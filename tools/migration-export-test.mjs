import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "heartecho-export-"));
process.env.HEARTECHO_DATA_DIR = path.join(temp, "data");
process.env.HEARTECHO_SETTINGS = path.join(temp, "settings.json");
const { paths, ensureDirs } = await import("../lib/paths.mjs");
ensureDirs();
const db = await import("../lib/db.mjs");
db.getDb();
const config = await import("../lib/config.mjs");
const { exportMigration } = await import("../lib/migration-export.mjs");
after(() => { db.closeDb(); fs.rmSync(temp, { recursive: true, force: true }); });

test("完整迁移导出保留角色、记忆、生命计划、图片和状态，移除服务凭据且不修改原数据", () => {
  config.saveCharacter("migration", { name: "迁移角色", persona: "保留我" });
  config.saveConfig({ llm: { profiles: { default: { apiKey: "SYNTHETIC_PRIVATE_EXPORT" } } }, bot: { accessToken: "SYNTHETIC_LOCAL_TOKEN" }, nextMemory: { enabled: true, apiKey: "SYNTHETIC_MEMORY_KEY", consentDigest: "old" } });
  db.run("INSERT INTO meta(key,value) VALUES(?,?)", ["migration-life-memory", "迁移生命计划和记忆"]);
  fs.writeFileSync(path.join(paths.media, "picture.png"), "synthetic-image");
  fs.writeFileSync(path.join(paths.state, "test.json"), JSON.stringify({ draft: "保留草稿", apiKey: "SYNTHETIC_OTHER_KEY" }));
  const result = exportMigration();
  assert.equal(result.ok, true);
  const output = result.directory;
  const next = JSON.parse(fs.readFileSync(path.join(output, "config.json")));
  assert.equal(next.llm.profiles.default.apiKey, "");
  assert.equal(next.bot.accessToken, "");
  assert.equal(next.nextMemory.enabled, false);
  assert.equal(next.onboarding.done, false);
  assert.equal(config.getConfig().llm.profiles.default.apiKey, "SYNTHETIC_PRIVATE_EXPORT");
  assert.ok(fs.existsSync(path.join(output, "characters", "migration.json")));
  assert.equal(fs.readFileSync(path.join(output, "media", "picture.png"), "utf8"), "synthetic-image");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, "state", "test.json"))), { draft: "保留草稿", apiKey: "" });
  const snapshot = new DatabaseSync(path.join(output, "database", "main.db"), { readOnly: true });
  try {
    assert.equal(snapshot.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.equal(snapshot.prepare("SELECT value FROM meta WHERE key=?").get("migration-life-memory").value, "迁移生命计划和记忆");
  } finally { snapshot.close(); }
});
