import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "heartecho-protocol-connect-"));
for (const key of Object.keys(process.env)) if (key.startsWith("HEARTECHO_")) delete process.env[key];
Object.assign(process.env, { HEARTECHO_APP_DIR: tmp, HEARTECHO_DATA_DIR: path.join(tmp, "data"),
  HEARTECHO_SNOWLUMA_DIR: path.join(tmp, "protocol"), HEARTECHO_LOG_DIR: path.join(tmp, "logs"), HEARTECHO_SETTINGS: path.join(tmp, "settings.json") });
const { ensureDirs, paths } = await import("../lib/paths.mjs");
ensureDirs();
const { saveConfig, getConfig } = await import("../lib/config.mjs");
const protocol = await import("../lib/protocol.mjs");
const { OneBot } = await import("../lib/onebot.mjs");
const { alignProtocolConnection } = await import("../lib/health.mjs");
const { redactText } = await import("../lib/log.mjs");
const listen = async (server) => { server.listen(0, "127.0.0.1"); await once(server, "listening"); return server.address().port; };

test("已运行 SnowLuma 的端口和令牌自动对齐，保留其它账号和协议端配置", async () => {
  const webui = http.createServer((req, res) => res.end("SnowLuma"));
  const onebot = http.createServer((req, res) => res.end("ok"));
  const webuiPort = await listen(webui), port = await listen(onebot);
  const dir = path.join(paths.snowluma, "config"); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(paths.snowluma, "index.mjs"), "");
  fs.writeFileSync(path.join(dir, "runtime.json"), JSON.stringify({ webuiPort }));
  const file = path.join(dir, "onebot_12345.json");
  const content = JSON.stringify({ networks: { wsServers: [{ name: "ws-default", host: "127.0.0.1", port, path: "/bot", accessToken: "fixture-protocol-token" }],
    httpServers: [{ name: "http-default", host: "127.0.0.1", port, path: "/http", accessToken: "fixture-protocol-token" }] } });
  fs.writeFileSync(file, content);
  saveConfig({ bot: { selfId: 12345, onebotWsUrl: "ws://127.0.0.1:1/", onebotHttpUrl: "http://127.0.0.1:2/", accessToken: "fixture-old-token" } });
  try {
    const result = await protocol.ensureProtocol();
    assert.equal(result.ok, true, result.message);
    assert.equal(getConfig().bot.onebotWsUrl, `ws://127.0.0.1:${port}/bot`);
    assert.equal(getConfig().bot.onebotHttpUrl, `http://127.0.0.1:${port}/http`);
    assert.ok(getConfig().bot.accessToken === "fixture-protocol-token", "应使用选定账号协议配置中的令牌");
    assert.equal(fs.readFileSync(file, "utf8"), content, "不得改写协议端网络服务");
    const recovering = protocol.recoverProtocolConnection();
    assert.equal(protocol.recoverProtocolConnection(), recovering, "连续修复必须共用任务");
    const recovery = await recovering;
    assert.equal(recovery.ok, false);
    assert.match(recovery.message, /外部协议端/);
    assert.equal((await fetch(`http://127.0.0.1:${port}`)).status, 200, "恢复不得结束外部协议进程");
  } finally { webui.closeAllConnections(); onebot.closeAllConnections(); await Promise.all([new Promise(r=>webui.close(r)), new Promise(r=>onebot.close(r))]); }
});

test("Node 内置 WebSocket 将协议端令牌发送到握手，日志不输出令牌", async () => {
  let received = false;
  const server = http.createServer();
  const port = await listen(server);
  server.on("upgrade", (req, socket) => {
    received = new URL(req.url, "http://localhost").searchParams.get("access_token") === "fixture-private +&token";
    socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
  });
  const bot = new OneBot({ url: `ws://127.0.0.1:${port}/`, accessToken: "fixture-private +&token" });
  try {
    bot.start();
    for (let i=0;i<40&&!received;i++) await new Promise(r=>setTimeout(r,25));
    assert.ok(received, "握手请求必须携带正确编码的 access_token，Node 的 WebSocket 不支持 headers 选项");
    assert.equal(redactText("ws://localhost/?access_token=fixture-private%20%2B%26token&other=value"), "ws://localhost/?access_token=***&other=value");
  } finally { bot.stop(); server.closeAllConnections(); await new Promise(r=>server.close(r)); }
});

test("不自动更改远程接口、不选择多个含糊服务，分别保存不同协议令牌", () => {
  const file = path.join(paths.snowluma, "config", "onebot_12345.json");
  const write = (wsServers, httpServers = []) => fs.writeFileSync(file, JSON.stringify({ networks: { wsServers, httpServers } }));
  const server = { host: "127.0.0.1", port: 3001, accessToken: "fixture-protocol-token" };
  saveConfig({ bot: { onebotWsUrl: "ws://example.invalid:3101/" } });
  write([server]);
  assert.equal(alignProtocolConnection().changed, false);
  saveConfig({ bot: { onebotWsUrl: "ws://127.0.0.1:3101/", onebotHttpUrl: "http://127.0.0.1:3100/" } });
  write([server, { ...server, port: 3003 }]);
  assert.equal(alignProtocolConnection().changed, false);
  write([{ ...server, enabled: false }]);
  assert.equal(alignProtocolConnection().changed, false);
  write([{ ...server, role: "Event" }]);
  assert.equal(alignProtocolConnection().changed, false);
  write([server], [{ ...server, port: 3000, accessToken: "fixture-different-token" }]);
  assert.equal(alignProtocolConnection().changed, true);
  assert.ok(getConfig().bot.accessToken === server.accessToken);
  assert.ok(getConfig().bot.httpAccessToken === "fixture-different-token");
});

test("HTTP 回退使用自身令牌，支持与 WebSocket 不同的认证设置", async () => {
  let valid = false;
  const server = http.createServer((req, res) => {
    valid = req.headers.authorization === "Bearer fixture-http-token";
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ status: "ok", retcode: 0, data: { user_id: 12345 } }));
  });
  const port = await listen(server);
  const bot = new OneBot({ url: "ws://127.0.0.1:1/", accessToken: "fixture-ws-token", httpAccessToken: "fixture-http-token", httpUrl: `http://127.0.0.1:${port}/` });
  try { await bot.callHttp("get_login_info", {}); assert.ok(valid); }
  finally { server.closeAllConnections(); await new Promise(r=>server.close(r)); }
});

test("重连时刷新地址与令牌，旧连接的关闭事件不能再启动额外重连", async () => {
  const server = http.createServer();
  const port = await listen(server);
  let count = 0;
  const sockets = new Set();
  server.on("upgrade", (req, socket) => {
    count++; sockets.add(socket);
    const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  const bot = new OneBot({ url: "ws://127.0.0.1:1/", accessToken: "old" });
  try {
    bot.start(); bot.stop();
    bot.applyConfig({ onebotWsUrl: `ws://127.0.0.1:${port}/`, accessToken: "new", selfId: 12345 });
    bot.start(); bot.start();
    for (let i=0;i<40&&!count;i++) await new Promise(r=>setTimeout(r,25));
    assert.equal(count, 1);
    assert.ok(bot.retry <= 1);
  } finally { bot.stop(); for (const socket of sockets) socket.destroy(); server.closeAllConnections(); await new Promise(r=>server.close(r)); }
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
