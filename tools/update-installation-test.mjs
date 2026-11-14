import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { releaseNotes } from "../lib/release-notes.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const setups = String(process.env.HEARTECHO_TEST_INSTALLERS || "")
  .split(path.delimiter)
  .filter(Boolean);
const previous = String(process.env.HEARTECHO_TEST_PREVIOUS_INSTALLERS || "")
  .split(path.delimiter)
  .filter(Boolean);
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

for (const setup of setups) {
  const tb = path.basename(setup).startsWith("领航员终端");
  const oldSetup = previous.find((file) => path.basename(file).startsWith(tb ? "领航员终端" : "心语-"));
  test(`覆盖升级与退出协调：${tb ? "TB" : "通用版"}`, { timeout: 70000, skip: !oldSetup }, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "heartecho-update-install-"));
    const target = path.join(tmp, "自定义 安装目录"),
      local = path.join(tmp, "local"),
      roaming = path.join(tmp, "roaming");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HEARTECHO_")));
    Object.assign(env, { LOCALAPPDATA: local, APPDATA: roaming, TEMP: tmp, TMP: tmp, HEARTECHO_UPDATE_CHECK: "0" });
    let data = tb ? path.join(local, "心语TB", "data") : path.join(local, "心语");
    const entry = path.join(target, tb ? "领航员终端.exe" : "心语.exe");
    const headers = {};
    let app, upgrader, port;
    const api = async (route, body) => {
      const result = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return result.json();
    };
    const start = async () => {
      app = spawn(entry, ["--no-panel", "--no-tray", "--no-autostart"], { env, stdio: "ignore", windowsHide: true });
      for (let i = 0; i < 100 && app.exitCode === null; i++) {
        try {
          headers.Authorization = "Bearer " + fs.readFileSync(path.join(data, "panel-token"), "utf8").trim();
          if ((await api("/api/status")).ok) return;
        } catch {
          /* 等面板启动 */
        }
        await delay(100);
      }
      throw new Error("隔离安装版未启动");
    };
    try {
      assert.equal(
        spawnSync(oldSetup, ["--silent", "--accept-license", "--dir=" + target], { env, timeout: 30000 }).status,
        0,
      );
      const oldVersion = JSON.parse(fs.readFileSync(path.join(target, "VERSION.json"), "utf8")).version;
      const localSettings = path.join(target, tb ? "心语TB设置.json" : "心语设置.json");
      if (fs.existsSync(localSettings)) {
        const settings = JSON.parse(fs.readFileSync(localSettings, "utf8").replace(/^\uFEFF/, ""));
        if (settings.dataDir) data = settings.dataDir;
      }
      fs.mkdirSync(path.join(data, "characters"), { recursive: true });
      port = await freePort();
      fs.writeFileSync(
        path.join(data, "config.json"),
        JSON.stringify({
          activeCharacter: "fixture",
          bot: { selfId: 0, masterId: 0, panelPort: port },
          tb: { initialized: true },
          weather: { enabled: false },
        }),
      );
      fs.writeFileSync(
        path.join(data, "characters", "fixture.json"),
        JSON.stringify({ id: "fixture", name: "升级前角色", persona: "保留的角色卡" }),
      );
      await start();
      const history = await api("/api/chat/local");
      const turn = await api("/api/chat/local", {
        characterId: "fixture",
        generation: history.generation,
        requestId: "upgrade-preserve-001",
        text: "记住：升级后要保留这条记忆",
      });
      assert.equal(turn.state, "done");
      const settings = fs.existsSync(localSettings) ? localSettings : tb ? path.join(local, "心语TB", "心语TB设置.json") : localSettings;
      const oldSettings = fs.existsSync(settings) ? fs.readFileSync(settings) : null;
      fs.mkdirSync(path.join(data, "media"), { recursive: true });
      fs.writeFileSync(path.join(data, "media", "user-background.png"), "user-image-preserve");
      const startup = path.join(
        roaming,
        "Microsoft",
        "Windows",
        "Start Menu",
        "Programs",
        "Startup",
        tb ? "领航员终端.lnk" : "心语机器人.lnk",
      );
      fs.mkdirSync(path.dirname(startup), { recursive: true });
      fs.writeFileSync(startup, "preserve-startup-setting");
      upgrader = spawn(
        setup,
        ["--silent", "--accept-license", "--update", "--dir=" + target, "--wait-pid=" + app.pid],
        { env, stdio: "ignore", windowsHide: true },
      );
      await delay(300);
      assert.equal(upgrader.exitCode, null, "安装器应等当前实例退出");
      assert.equal(JSON.parse(fs.readFileSync(path.join(target, "VERSION.json"), "utf8")).version, oldVersion);
      await api("/api/system/quit", {});
      if (app.exitCode === null) await new Promise((resolve) => app.once("exit", resolve));
      const code =
        upgrader.exitCode === null ? await new Promise((resolve) => upgrader.once("exit", resolve)) : upgrader.exitCode;
      assert.equal(code, 0, "覆盖安装失败");
      const current = JSON.parse(fs.readFileSync(path.join(target, "VERSION.json"), "utf8")).version;
      assert.equal(current, JSON.parse(fs.readFileSync("package.json", "utf8")).version);
      assert.notEqual(current, oldVersion);
      assert.equal(fs.readFileSync(startup, "utf8"), "preserve-startup-setting");
      const oldData = data;
      data = path.join(target, "data");
      const newSettings = JSON.parse(fs.readFileSync(path.join(target, tb ? "心语TB设置.json" : "心语设置.json"), "utf8"));
      assert.equal(newSettings.dataDir, data);
      if (oldSettings) for (const [key, value] of Object.entries(JSON.parse(oldSettings))) {
        if (!["dataDir", "logDir"].includes(key)) assert.deepEqual(newSettings[key], value, key);
      }
      if (oldData !== data) {
        assert.equal(newSettings.previousDataDir, oldData);
        assert.ok(fs.existsSync(path.join(oldData, "database", "main.db")), "旧数据保留供用户回退");
        assert.deepEqual(fs.readFileSync(path.join(data, "config.json")), fs.readFileSync(path.join(oldData, "config.json")), "搬迁必须保留用户配置和原有Key");
        assert.deepEqual(fs.readFileSync(path.join(data, "database", "main.db")), fs.readFileSync(path.join(oldData, "database", "main.db")), "搬迁数据库应完整一致");
        assert.ok(fs.existsSync(path.join(data, "state", "storage-migration.json")));
      }
      assert.equal(fs.readFileSync(path.join(data, "media", "user-background.png"), "utf8"), "user-image-preserve");
      const receipt = JSON.parse(
        fs.readFileSync(path.join(data, "state", "update-install.json"), "utf8").replace(/^\uFEFF/, ""),
      );
      assert.equal(receipt.fromVersion, oldVersion);
      assert.equal(receipt.version, current);
      await start();
      const system = await api("/api/system");
      assert.equal(system.paths.data, data); assert.equal(system.paths.logs, path.join(data, "logs"));
      const restored = await api("/api/chat/local");
      assert.equal(restored.character.name, "升级前角色");
      assert.ok(restored.messages.some((m) => m.body.includes("升级后要保留这条记忆")));
      const update = await api("/api/updates");
      assert.equal(update.notice.version, current);
      assert.equal(update.notice.fromVersion, oldVersion);
      assert.equal(update.notice.body, releaseNotes.body, "安装后仅展示随当前版本提供的更新内容");
      assert.equal(update.notice.guide, releaseNotes.guide);
      assert.equal(update.notice.body.includes(oldVersion), false, "不把旧版本公告拼入本版正文");
      assert.equal((await api("/api/updates/acknowledge", { version: current })).ok, true);
      assert.equal((await api("/api/updates")).notice, null);
      await api("/api/system/quit", {});
      if (app.exitCode === null) await new Promise((resolve) => app.once("exit", resolve));
    } finally {
      if (app?.exitCode === null) {
        try {
          await api("/api/system/quit", {});
        } catch {
          /* 已退出 */
        }
        await Promise.race([new Promise((resolve) => app.once("exit", resolve)), delay(3000)]);
        if (app.exitCode === null) spawnSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { windowsHide: true });
      }
      if (upgrader?.exitCode === null)
        spawnSync("taskkill", ["/PID", String(upgrader.pid), "/T", "/F"], { windowsHide: true });
      assert.equal(path.dirname(tmp), os.tmpdir());
      assert.ok(path.basename(tmp).startsWith("heartecho-update-install-"));
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
    }
  });
}
