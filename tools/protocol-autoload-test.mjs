import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "heartecho-autoload-"));
for (const key of Object.keys(process.env)) if (key.startsWith("HEARTECHO_")) delete process.env[key];
Object.assign(process.env, { HEARTECHO_APP_DIR: tmp, HEARTECHO_DATA_DIR: path.join(tmp, "data"), HEARTECHO_LOG_DIR: path.join(tmp, "logs"), HEARTECHO_SETTINGS: path.join(tmp, "settings.json"), HEARTECHO_SNOWLUMA_DIR: path.join(tmp, "protocol") });
const { ensureDirs, paths } = await import("../lib/paths.mjs");
ensureDirs();
const { saveConfig } = await import("../lib/config.mjs");
const protocol = await import("../lib/protocol.mjs");

test("SnowLuma 自动接入关闭时准确诊断，一键开启保留其他设置与原始备份", async () => {
  const server = http.createServer((req, res) => res.end("SnowLuma"));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const dir = path.join(paths.snowluma, "config");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(paths.snowluma, "index.mjs"), "");
  fs.writeFileSync(path.join(paths.snowluma, "package.json"), JSON.stringify({ name: "@snowluma/runtime", version: "1.14.22" }));
  const file = path.join(dir, "runtime.json");
  const original = JSON.stringify({ webuiPort: server.address().port, hookAutoLoad: false, logRetainDays: 7 });
  fs.writeFileSync(file, original);
  fs.writeFileSync(path.join(dir, "onebot_12345.json"), JSON.stringify({ networks: { wsServers: [{ port: 1, host: "127.0.0.1" }] } }));
  saveConfig({ bot: { selfId: 12345, onebotWsUrl: "ws://127.0.0.1:1/" } });
  try {
    const report = await protocol.diagnoseProtocol();
    assert.ok(report.blockers.some(b => b.id === "autoload-disabled"), "不应把关闭自动接入误报为普通端口问题");
    assert.equal(report.hookAutoLoad, false);
    assert.equal(fs.readFileSync(file, "utf8"), original, "只诊断不能修改用户配置");
    const result = protocol.enableProtocolAutoLoad();
    assert.equal(result.ok, true);
    assert.equal(result.restartNeeded, true);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).hookAutoLoad, true);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).logRetainDays, 7);
    assert.equal(fs.readFileSync(result.backup, "utf8"), original);
    assert.equal(protocol.enableProtocolAutoLoad().changed, false);
    fs.writeFileSync(file, "{broken");
    assert.equal(protocol.enableProtocolAutoLoad().ok, false);
    assert.equal(fs.readFileSync(file, "utf8"), "{broken");
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test("一键接入接口需要面板授权，外部手动协议进程只提示重启且不终止", { timeout: 20000 }, async () => {
  const webui = http.createServer((req, res) => res.end("SnowLuma"));
  const portPicker = http.createServer();
  await new Promise(resolve => webui.listen(0, "127.0.0.1", resolve));
  await new Promise(resolve => portPicker.listen(0, "127.0.0.1", resolve));
  const panelPort = portPicker.address().port;
  await new Promise(resolve => portPicker.close(resolve));
  const runtime = path.join(paths.snowluma, "config", "runtime.json");
  fs.writeFileSync(runtime, JSON.stringify({ hookAutoLoad: false, webuiPort: webui.address().port }));
  saveConfig({ bot: { panelPort, selfId: 12345 }, weather: { enabled: false } });
  fs.writeFileSync(process.env.HEARTECHO_SETTINGS, JSON.stringify({ autoStartProtocol: false, snowlumaDir: paths.snowluma }));
  const app = spawn(process.execPath, [path.resolve(process.env.HEARTECHO_TEST_APP_ROOT || process.cwd(), "index.mjs"), "--no-panel", "--no-tray", "--no-autostart"], {
    windowsHide: true, stdio: "ignore", env: { ...process.env, HEARTECHO_CLAIM_DIR: path.join(tmp, "claims"), HEARTECHO_INSTANCES_HOME: path.join(tmp, "instances"), HEARTECHO_UPDATE_CHECK: "0" },
  });
  const base = `http://127.0.0.1:${panelPort}`;
  let headers;
  try {
    for (let i = 0; i < 80; i++) {
      try {
        headers = { Authorization: "Bearer " + fs.readFileSync(path.join(paths.data, "panel-token"), "utf8").trim(), "Content-Type": "application/json" };
        if ((await fetch(base + "/api/status", { headers })).ok) break;
      } catch { /* 等待测试实例就绪 */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const route = base + "/api/protocol/enable-autoload";
    const denied = await fetch(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(denied.status, 401);
    assert.equal(JSON.parse(fs.readFileSync(runtime, "utf8")).hookAutoLoad, false);
    const response = await fetch(route, { method: "POST", headers, body: "{}" }).then(r => r.json());
    assert.equal(response.enabled, true);
    assert.equal(response.ok, false, "手动启动的协议端不应被心语终止");
    assert.match(response.message, /手动重启/);
    assert.equal(JSON.parse(fs.readFileSync(runtime, "utf8")).hookAutoLoad, true);
    assert.equal((await fetch(`http://127.0.0.1:${webui.address().port}/`)).status, 200);
  } finally {
    if (headers) await fetch(base + "/api/system/quit", { method: "POST", headers, body: "{}" }).catch(() => {});
    if (app.exitCode === null) {
      await Promise.race([new Promise(resolve => app.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
      if (app.exitCode === null) app.kill();
    }
    webui.closeAllConnections(); await new Promise(resolve => webui.close(resolve));
  }
});
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
