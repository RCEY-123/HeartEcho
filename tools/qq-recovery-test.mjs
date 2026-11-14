import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "heartecho-qq-recovery-"));
for (const key of Object.keys(process.env)) if (key.startsWith("HEARTECHO_")) delete process.env[key];
Object.assign(process.env, { HEARTECHO_APP_DIR: tmp, HEARTECHO_DATA_DIR: path.join(tmp, "data"), HEARTECHO_LOG_DIR: path.join(tmp, "logs"), HEARTECHO_SETTINGS: path.join(tmp, "settings.json"), HEARTECHO_LOG_LEVEL: "error" });
const { OneBot } = await import("../lib/onebot.mjs");
const originalWebSocket = globalThis.WebSocket;
class BridgeSocket extends EventTarget {
  static all = [];
  constructor() { super(); this.readyState = 0; BridgeSocket.all.push(this); }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  post(payload) { const event = new Event("message"); event.data = JSON.stringify(payload); this.dispatchEvent(event); }
  send(data) { this.lastCall = JSON.parse(data); }
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
}
function setup() {
  globalThis.WebSocket = BridgeSocket;
  const client = new OneBot({ url: "ws://127.0.0.1:1/", selfId: 12345 });
  client.start(); const socket = client.ws; socket.open();
  return { client, socket };
}
test("QQ退出但协议端WS还活着时不能继续显示账号在线", () => {
  const { client, socket } = setup();
  try {
    socket.post({ post_type: "meta_event", meta_event_type: "heartbeat", self_id: 12345, status: { online: false, good: false } });
    assert.equal(client.online, false, "QQ已掉线，WS端口在线不能当成QQ在线");
  } finally { client.stop(); }
});
test("点击重连必须结束旧请求，不能让旧超时阻塞新一轮接收处理", async () => {
  const { client } = setup();
  let settled = false;
  const pending = client.call("get_private_msg_history", { user_id: 67890 }, { timeoutMs: 2000 }).catch(() => { settled = true; });
  try {
    client.stop(); client.start(); client.ws.open();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, true, "重连后旧请求仍挂起，调用链无法及时释放");
  } finally {
    client.stop();
    for (const item of client.pending.values()) { clearTimeout(item.timer); item.reject(new Error("test cleanup")); }
    client.pending.clear(); await pending;
  }
});
test("WebSocket报错但未发close时仍需恢复，不能永久挂在失效连接", () => {
  const { client, socket } = setup();
  try {
    socket.dispatchEvent(new Event("error"));
    assert.equal(client.connected, false, "错误后的连接仍被标记可用，无法触发重连");
  } finally { client.stop(); }
});
after(() => { globalThis.WebSocket = originalWebSocket; fs.rmSync(tmp, { recursive: true, force: true }); });
