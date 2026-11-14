import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";

for (const { accountBusy, encrypted } of [{ accountBusy: false }, { accountBusy: true }, { accountBusy: false, encrypted: true }]) test("面板端口冲突时仍能读取本实例数据" + (accountBusy ? "，旧 QQ 实例继续运行也不阻塞面板" : encrypted ? "，兼容本机加密用户目录" : ""), { timeout: 16000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(encrypted && process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA : os.tmpdir(), "heartecho-port-conflict-"));
  const blocker = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const occupied = blocker.address().port;
  const data = path.join(tmp, "data");
  fs.mkdirSync(path.join(data, "characters"), { recursive: true });
  fs.writeFileSync(path.join(data, "characters", "fixture.json"), JSON.stringify({ id: "fixture", name: "fixture" }));
  fs.writeFileSync(path.join(data, "config.json"), JSON.stringify({ activeCharacter: "fixture", bot: { selfId: accountBusy ? 10000001 : 0, panelPort: occupied }, weather: { enabled: false } }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HEARTECHO_")));
  Object.assign(env, { HEARTECHO_DATA_DIR: data, HEARTECHO_SETTINGS: path.join(tmp, "settings.json"), HEARTECHO_LOG_DIR: path.join(tmp, "logs"), HEARTECHO_UPDATE_CHECK: "0", HEARTECHO_LOG_LEVEL: "error" });
  Object.assign(env, { HEARTECHO_CLAIM_DIR: path.join(tmp, "claims"), HEARTECHO_INSTANCES_HOME: path.join(tmp, "instances") });
  fs.mkdirSync(env.HEARTECHO_CLAIM_DIR);
  if (accountBusy) fs.writeFileSync(path.join(env.HEARTECHO_CLAIM_DIR, "10000001.json"), JSON.stringify({ pid: process.pid, startedAt: Date.now(), dir: path.join(tmp, "old-app"), dataDir: path.join(tmp, "old-data"), panelPort: occupied }));
  const app = spawn(process.execPath, ["index.mjs", "--no-panel", "--no-tray", "--no-autostart"], { env, cwd: process.env.HEARTECHO_TEST_APP_ROOT || process.cwd(), stdio: "ignore", windowsHide: true });
  let headers, port;
  try {
    for (let i = 0; i < 50; i++) {
      try {
        port = JSON.parse(fs.readFileSync(path.join(data, "config.json"))).bot.panelPort;
        if (port !== occupied && fs.existsSync(path.join(data, "panel-token"))) {
          const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
          if (response.ok) break;
        }
      } catch { /* 等待跨进程文件提交和面板就绪；Windows复制期间可能短暂拒绝读取 */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.notEqual(port, occupied, "端口冲突后不能留下无界面的后台进程，应保存新的可用面板端口");
    headers = { Authorization: "Bearer " + fs.readFileSync(path.join(data, "panel-token"), "utf8").trim() };
    const roles = await fetch(`http://127.0.0.1:${port}/api/characters`, { headers }).then((r) => r.json());
    assert.equal(roles.list.length, 1);
    const system = await fetch(`http://127.0.0.1:${port}/api/system`, { headers }).then((r) => r.json());
    assert.equal(path.resolve(system.paths.data), path.resolve(data));
    assert.ok(system.startupWarnings.some((text) => text.includes("端口")));
    if (accountBusy) {
      assert.ok(system.startupWarnings.some((text) => text.includes("QQ")));
      assert.equal(JSON.parse(fs.readFileSync(path.join(env.HEARTECHO_CLAIM_DIR, "10000001.json"))).pid, process.pid, "不能夺取旧进程的QQ占位");
      assert.equal(JSON.parse(fs.readFileSync(path.join(data, "config.json"))).bot.selfId, 10000001, "保留QQ配置，下次重启仍能恢复接入");
    }
  } finally {
    if (headers) await fetch(`http://127.0.0.1:${port}/api/system/quit`, { method: "POST", headers, body: "{}" }).catch(() => {});
    if (app.exitCode === null) app.kill();
    if (app.exitCode === null) await new Promise((resolve) => app.once("exit", resolve));
    await new Promise((resolve) => blocker.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
