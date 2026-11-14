import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "heartecho-qq-catchup-"));
for (const k of Object.keys(process.env)) if (k.startsWith("HEARTECHO_")) delete process.env[k];
Object.assign(process.env, { HEARTECHO_APP_DIR: tmp, HEARTECHO_DATA_DIR: path.join(tmp, "data"), HEARTECHO_SETTINGS: path.join(tmp, "settings.json"), HEARTECHO_LOG_DIR: path.join(tmp, "logs"), HEARTECHO_LOG_LEVEL: "error" });
(await import("../lib/paths.mjs")).ensureDirs();
const db = await import("../lib/db.mjs");
const config = await import("../lib/config.mjs");
const { ChatEngine } = await import("../lib/chat.mjs");
const { QQRecovery } = await import("../lib/qq-recovery.mjs");
const { normalizeEvent } = await import("../lib/onebot.mjs");
const { pauseState } = await import("../lib/policy.mjs");
const { clearMessages } = await import("../lib/storage.mjs");
db.getDb();
config.saveCharacter("fixture", { name: "测试角色", persona: "说话简短的港区伙伴" });
const SELF = 12345, PEER = 67890;
let clock, client, chat, recovery, sent, generations, history, failModel, failSend;
class Bridge extends EventEmitter {
  constructor() { super(); this.selfId = SELF; this.connected = true; this.connectionGeneration = 1; this.status = { online: true }; }
  async call(action) { return action === "get_status" ? { online: true, good: this.good !== false } : { user_id: this.selfId, nickname: "fixture" }; }
  async callHttp(action, params) { assert.equal(action, "get_friend_msg_history"); assert(/^[1-9]\d*$/.test(String(params.user_id)), "不得向协议端发送本地角色ID"); return { messages: history.filter(m => m.user_id === params.user_id) }; }
  async sendPrivateMsg(peer, text) { assert.equal(String(peer), String(PEER)); if (failSend) throw new Error("fixture send unknown"); sent.push(text); return { message_id: "out-" + sent.length }; }
  setAccountStatus(online) { this.status.online = online; }
  start() { this.connected = true; }
  stop() { this.connected = false; this.connectionGeneration++; }
}
const raw = (id, text, seconds = 0) => ({ message_type: "private", user_id: PEER, sender: { user_id: PEER, nickname: "fixture-peer" }, message_id: id, time: Math.floor(clock / 1000) + seconds, message: [{ type: "text", data: { text } }] });
beforeEach(() => {
  recovery?.stop(); chat?.stop();
  for (const table of ["messages", "message_origins", "sessions", "outgoing", "meta", "rate_events", "interaction_claims", "scope_resets"]) db.run(`delete from ${table}`);
  fs.rmSync(path.join(tmp, "data/state/qq-recovery.json"), { force: true });
  clock = Date.now() - 100000;
  config.saveConfig({ activeCharacter: "fixture", bot: { selfId: SELF, masterId: PEER }, chat: { replyPrivate: true, quietHours: { enabled: false }, firstDelayMs: 0, rememberFacts: false, activity: 0, followUp: { enabled: false } }, nextMemory: { enabled: false }, weather: { enabled: false } });
  pauseState.paused = false; sent = []; generations = []; history = []; failModel = false; failSend = false;
  client = new Bridge();
  chat = new ChatEngine({ client, llm: {} });
  chat.generate = async ({ event, character }) => {
    if (failModel) throw new Error("fixture model unavailable");
    const context = chat.buildContext({ event, character }); generations.push({ event, context });
    return { bubbles: ["我回来了。刚才的问题，我们接着说。"], usage: {}, context, style: { activity: 0 } };
  };
  recovery = new QQRecovery({ client, chat, now: () => clock, reconnectTransport: async () => ({ ok: true }) });
});
test("初次启用仅记录旧历史，QQ离线重连后合并补答并解释离开，后续新消息仍能回复", async () => {
  history = [raw("old", "旧消息", -30)];
  await recovery.tick(); assert.equal(sent.length, 0);
  clock += 2000; recovery.disconnected();
  history.push(raw("missed-1", "明天能一起看海吗？"), raw("missed-2", "下午出发如何？", 1));
  clock += 3000; await recovery.tick();
  assert.equal(sent.length, 1, "历史补存后仍必须进入真实对话发送链路");
  assert.match(generations[0].context.extras, /先按你的人设/);
  assert.match(generations[0].event.text, /明天能一起看海.*\n下午出发/s);
  assert.equal(db.one("select count(*) n from messages where direction='in'").n, 3);
  await recovery.tick(); assert.equal(sent.length, 1, "重复点击和重查不重复补答");
  const event = normalizeEvent({ ...raw("live", "我又发了一条新消息"), post_type: "message", self_id: SELF }, SELF);
  const result = await chat.handle(event); assert.equal(result.replied, true); assert.equal(sent.length, 2);
  assert(db.one("select 1 from messages where event_key = ?", [event.eventId]), "恢复后的实时消息必须落库");
});
test("后台历史轮询不能把正在合并的ABCD登记成漏消息并在正常回复后重复补答", async () => {
  config.saveConfig({ chat: { privateMergeWindowSec: 1, privateMaxWaitSec: 5 } });
  await recovery.tick(); clock += 2000;
  history = ["A", "B", "C", "D"].map(part => raw("live-burst-" + part, part));
  for (const message of history) await chat.receive(normalizeEvent({ ...message, post_type: "message", self_id: SELF }, SELF));
  // 模拟旧版本留下的补答重试记录，升级后正常合并回复也必须结清全部原消息。
  recovery.record(history.map(message => normalizeEvent({ ...message, post_type: "message", self_id: SELF }, SELF)), "fixture", SELF, "retry");
  await recovery.tick();
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(sent.length, 1); assert.equal(generations[0].event.text, "A\nB\nC\nD");
  clock += 31000; await recovery.tick();
  assert.equal(sent.length, 1, "合并正常回复后，后台补收不能把A、B、C再回答一次");
});
test("事件推送静默但历史接口可用时继续补收并回复新消息，不用重启电脑", async () => {
  await recovery.tick(); clock += 2000;
  client.good = false; recovery.retryAt = clock + 60000;
  history = [raw("poll-only", "事件推送中断后发出的消息")];
  await recovery.tick();
  await recovery.tick(); assert.equal(sent.length, 1); assert.equal(client.status.recovery, "history-fallback");
});
test("模型临时失败保留补答任务，恢复后重试，发送状态未知不重发", async () => {
  await recovery.tick(); clock += 2000; recovery.disconnected(); history = [raw("retry", "请接着回复")];
  failModel = true; await recovery.tick(); assert.equal(sent.length, 0);
  failModel = false; clock += 31000; await recovery.tick(); assert.equal(sent.length, 1);
  clock += 2000; recovery.disconnected(); history.push(raw("unknown", "另一条漏接消息")); failSend = true;
  await recovery.tick(); const count = generations.length; failSend = false;
  clock += 31000; await recovery.tick(); assert.equal(generations.length, count, "结果未知不重新生成/发送");
});
test("全局暂停与清空边界在补答时仍生效，不恢复已清空的旧消息", async () => {
  await recovery.tick(); clock += 2000; recovery.disconnected(); history = [raw("paused", "不要绕过暂停")];
  pauseState.paused = true; await recovery.tick(); assert.equal(sent.length, 0);
  clearMessages(`private_${PEER}`); pauseState.paused = false; clock += 31000; await recovery.tick();
  assert.equal(sent.length, 0); assert.equal(db.one("select count(*) n from messages").n, 0);
});
test("错号连接不拉取历史、不向任何人补答", async () => {
  client.call = async action => action === "get_status" ? { online: true, good: true } : { user_id: 99999 };
  let historyCalls = 0; client.callHttp = async () => { historyCalls++; return {}; };
  await recovery.tick(); assert.equal(historyCalls, 0); assert.equal(sent.length, 0);
});
test("没有漏接消息也按人设说回来一次，不写入虚构用户消息", async () => {
  await recovery.tick(); clock += 2000; recovery.disconnected(); clock += 2000;
  await recovery.tick(); assert.equal(sent.length, 1); assert.equal(generations[0].event.reconnection.noticeOnly, true);
  assert.equal(db.one("select count(*) n from messages where direction='in'").n, 0);
  await recovery.tick(); assert.equal(sent.length, 1);
});
test("首次问候信号必须等漏消息补答完成后才发出", async () => {
  await recovery.tick(); clock += 2000; recovery.disconnected(); client.connectionGeneration++;
  history = [raw("before-greet", "离线时的问题")];
  let ready = false;
  client.once("account-ready", () => { ready = true; assert.equal(sent.length, 1, "问候抢在补答前会遮掉未回复消息"); });
  await recovery.tick(); assert.equal(ready, true);
});
test("85条积压分批补答且跨恢复控制器重启不遗漏、不重复", async () => {
  await recovery.tick(); clock += 2000; recovery.disconnected();
  history = Array.from({ length: 85 }, (_, i) => raw("backlog-" + i, "漏消息" + i));
  await recovery.tick(); assert.equal(generations[0].event.mergedEventIds.length, 40);
  recovery.stop(); recovery = new QQRecovery({ client, chat, now: () => clock });
  clock += 31000; await recovery.tick(); clock += 31000; await recovery.tick();
  assert.equal(generations.length, 3);
  assert.equal(new Set(generations.flatMap(g => g.event.mergedEventIds)).size, 85);
  assert.equal(generations.filter(g => g.event.reconnection.explainAbsence).length, 1);
  await recovery.tick(); assert.equal(sent.length, 3);
});
test("连续点击重连只启动一次协议修复", async () => {
  let release; let repairs = 0;
  recovery.reconnectTransport = () => { repairs++; return new Promise(resolve => { release = resolve; }); };
  const first = recovery.reconnect(), second = recovery.reconnect(); assert.equal(first, second);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(repairs, 1);
  release(); await first; assert.equal(client.connected, true);
});
test("手动重连不等待旧模型请求超时", async () => {
  await recovery.tick(); clock += 2000; recovery.disconnected(); history = [raw("slow-model", "等待中的补答")];
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; }); const generate = chat.generate;
  chat.generate = async args => { entered(); await new Promise(resolve => { release = resolve; }); return generate(args); };
  const oldCheck = recovery.tick(); await started;
  let connected = false; const reconnect = recovery.reconnect().then(() => { connected = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(connected, true);
  release(); await oldCheck; await reconnect; assert.equal(sent.length, 0);
});
test("历史超过一页时按锚点翻页，跨轮恢复后完整补答", async () => {
  config.saveConfig({ group: { rate: { perUserPerMinute: 100, perUserPerHour: 100, perUserPerDay: 100 } } });
  await recovery.tick(); clock += 2000; recovery.disconnected();
  history = Array.from({ length: 340 }, (_, i) => raw(String(1000 + i), "跨页问题" + i, i));
  clock += 340000;
  client.callHttp = async (action, params) => {
    assert.equal(action, "get_friend_msg_history");
    const end = params.message_id ? history.findIndex(m => m.message_id === String(params.message_id)) + 1 : history.length;
    return { messages: history.slice(Math.max(0, end - params.count), end) };
  };
  await recovery.tick(); assert.equal(sent.length, 0, "历史尚未拉齐，不提前补答较晚的消息");
  recovery.stop(); recovery = new QQRecovery({ client, chat, now: () => clock });
  for (let i = 0; i < 9; i++) { clock += 16000; await recovery.tick(); }
  assert.equal(new Set(generations.flatMap(g => g.event.mergedEventIds)).size, 340, JSON.stringify({ decisions: chat.decisions, state: recovery.state(), status: client.status }));
  assert.equal(generations.filter(g => g.event.reconnection.explainAbsence).length, 1);
});
test("断线前生成中的旧回复不会在重连后发送", async () => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const generate = chat.generate;
  chat.generate = async args => { entered(); await new Promise(resolve => { release = resolve; }); return generate(args); };
  const event = normalizeEvent({ ...raw("stale-generation", "尚未生成完成"), post_type: "message", self_id: SELF }, SELF);
  const old = chat.handle(event); await started;
  client.stop(); recovery.disconnected(); client.start(); release(); await old;
  assert.equal(sent.length, 0, "旧连接的回复不能越过重连边界");
  chat.generate = generate;
  const live = normalizeEvent({ ...raw("fresh-generation", "重连后的新消息"), post_type: "message", self_id: SELF }, SELF);
  assert.equal((await chat.handle(live)).replied, true); assert.equal(sent.length, 1);
});
after(() => { recovery.stop(); chat.stop(); db.closeDb(); fs.rmSync(tmp, { recursive: true, force: true }); });
