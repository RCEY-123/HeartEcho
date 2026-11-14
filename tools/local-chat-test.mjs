import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import vm from "node:vm";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "heartecho-local-test-"));
for (const key of Object.keys(process.env)) if (key.startsWith("HEARTECHO_")) delete process.env[key];
Object.assign(process.env, {
  HEARTECHO_APP_DIR: tmp,
  HEARTECHO_DATA_DIR: path.join(tmp, "data"),
  HEARTECHO_LOG_DIR: path.join(tmp, "logs"),
  HEARTECHO_SETTINGS: path.join(tmp, "settings.json"),
  HEARTECHO_LOG_LEVEL: "error",
});
(await import("../lib/paths.mjs")).ensureDirs();
const db = await import("../lib/db.mjs");
const config = await import("../lib/config.mjs");
const life = await import("../lib/life.mjs");
const memory = await import("../lib/memory.mjs");
const { ChatEngine } = await import("../lib/chat.mjs");
const { Scheduler, addReminder } = await import("../lib/scheduler.mjs");
const { LlmGateway } = await import("../lib/llm.mjs");
const { createApiServer } = await import("../lib/api.mjs");
const { panelToken } = await import("../lib/panel-auth.mjs");
const { privateUserProfile } = await import("../lib/privacy.mjs");
const { localScope, localPeer, LOCAL_ACCOUNT_ID } = await import("../lib/local-channel.mjs");
const { APP_JS } = await import("../lib/ui-app.mjs");
const { ExtensionHost } = await import("../lib/extensions.mjs");
const extended = await import("../lib/extended-memory.mjs");
const { startManagedHindsight, managedHindsightUrl } = await import("../lib/hindsight-runtime.mjs");
const { digest } = await import("../lib/service-http.mjs");
db.getDb();
config.saveCharacter("fixture", {
  name: "小语",
  persona: "一起生活的朋友",
  user: { notes: "LOCAL_PROFILE_ONLY" },
  localUserEnabled: true,
});
config.saveCharacter("second", { name: "另一位", persona: "独立角色" });
const calls = [];
let answer = () => "好呀，我们明天一起看看。";
let blockModel = null;
const model = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  calls.push(body);
  if (blockModel) await blockModel.promise;
  const content = answer(body);
  const message = typeof content === "string" ? { role: "assistant", content } : content;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      id: "mock",
      choices: [{ message, finish_reason: message.finish_reason || (message.tool_calls ? "tool_calls" : "stop") }],
      usage: { prompt_tokens: 50, completion_tokens: 10 },
    }),
  );
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
const modelUrl = `http://127.0.0.1:${model.address().port}/v1`;
const realFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  assert.equal(new URL(url).hostname, "127.0.0.1", "tests must never contact a real provider");
  return realFetch(url, options);
};
let qqSends = 0;
const client = {
  selfId: 0,
  status: {},
  queue: [],
  sendPrivateMsg: async () => {
    qqSends++;
    throw new Error("QQ must not be used");
  },
};
const llm = new LlmGateway();
const scheduler = new Scheduler({ client, llm });
const chat = new ChatEngine({ client, llm, scheduler });
const api = createApiServer({ client, llm, chat, scheduler, control: {}, log: { info() {}, warn() {}, error() {} } });
await api.listen(0, "127.0.0.1");
const base = `http://127.0.0.1:${api.server.address().port}`;
const token = panelToken();
async function request(route, body, authorized = true) {
  const res = await fetch(base + route, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(authorized ? { Authorization: "Bearer " + token } : {}), "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() };
}
let sequence = 0;
const payload = (text, extra = {}) => ({
  characterId: config.activeCharacterId(),
  requestId: "request-" + String(++sequence).padStart(8, "0"),
  generation: chat.local.history().generation,
  text,
  ...extra,
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { resolve, promise };
};
async function until(check) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out");
}
beforeEach(async () => {
  config.saveConfig({
    activeCharacter: "fixture",
    bot: { selfId: 0, masterId: 0 },
    llm: {
      activeProfile: "default",
      profiles: {
        default: { provider: "custom", baseUrl: modelUrl, apiKey: "mock-only", model: "fixture", maxTokens: 1000 },
      },
    },
    chat: {
      privateMergeWindowSec: 1,
      privateMaxWaitSec: 5,
      firstDelayMs: 0,
      typingDelayMs: 0,
      antiStall: false,
      splitBubbles: false,
      maxReplyChars: 180,
      maxBubbles: 3,
      rememberFacts: true,
      followUp: { enabled: false },
    },
    group: { rate: { enabled: false } },
    weather: { enabled: false },
    life: { enabled: true },
    nextMemory: { enabled: false, mode: "hindsight", managed: false },
    greet: {
      firstOpen: { enabled: false, channel: "local" },
      morning: { enabled: false },
      noon: { enabled: false },
      night: { enabled: false },
      holidays: { enabled: false },
      birthdays: { enabled: false },
      proactive: { enabled: false, targets: [] },
    },
  });
  answer = () => "好呀，我们明天一起看看。";
  chat.extensions = null;
  blockModel = null;
  calls.length = 0;
  await chat.clearConversation(localScope("fixture"));
  await chat.clearConversation(localScope("second"));
});
after(async () => {
  chat.stop();
  scheduler.stop();
  api.close();
  api.server.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  globalThis.fetch = realFetch;
  assert.equal(qqSends, 0);
  db.closeDb();
  assert.equal(path.dirname(tmp), os.tmpdir());
  assert.ok(path.basename(tmp).startsWith("heartecho-local-test-"));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("native chat stores and displays a complete long reply including semantic parentheses", async () => {
  config.saveConfig({ chat: { maxReplyChars: 20, maxBubbles: 1 } });
  const text = "我（明天一定）会回来，记得【带伞】。".repeat(25) + "答应你的不会忘记。";
  answer = () => text;
  const result = await chat.local.send(payload("接着说吧"));
  assert.equal(result.state, "done");
  assert.deepEqual(chat.local.history().messages.filter(m => m.direction === "out").map(m => m.body), [text]);
});

test("model metadata markers are absent from native API history and the next model context", async () => {
  const expected = "轻一点哦，角根有些怕痒。今天热乎乎的，给你暖手。";
  answer = () => "[:: 10000001 ::]轻一点哦，角根有些怕痒。[:: 0.20 :]]今天热乎乎的，给你暖手。";
  const result = await request("/api/chat/local", payload("我想握一下你的角"));
  assert.equal(result.body.state, "done");
  const history = (await request("/api/chat/local")).body;
  assert.equal(history.messages.filter(m => m.direction === "out").map(m => m.body).join(""), expected);
  answer = () => "嗯，慢慢来就好。";
  await request("/api/chat/local", payload("好，我会轻一点"));
  const prior = calls.at(-1).messages.filter(m => m.role === "assistant").map(m => m.content).join("");
  assert.equal(prior, expected);
});

test("thought transport markers are absent from HTTP replies, persisted history and the next model context", async () => {
  const expected = "我已经把小毯子盖在腿上啦，暖呼呼的呢。你也记得保暖。";
  answer = () => "[::thought\n]::我已经把小毯子盖在腿上啦，暖呼呼的呢。[::thought\\n]::你也记得保暖。";
  const result = await request("/api/chat/local", payload("盖好毯子了吗"));
  assert.equal(result.body.state, "done");
  const history = (await request("/api/chat/local")).body;
  assert.equal(history.messages.filter(m => m.direction === "out").map(m => m.body).join(""), expected);
  assert.equal(db.all("select body from messages where scope_key=? and direction='out' order by id", [localScope("fixture")]).map(m => m.body).join(""), expected);
  answer = () => "好呀，我们都暖和一点。";
  await request("/api/chat/local", payload("好，我也盖好了"));
  const prior = calls.at(-1).messages.filter(m => m.role === "assistant").map(m => m.content).join("");
  assert.equal(prior, expected);
});

test("scheduled QQ-style greeting regenerates a length-truncated reply before delivering", async () => {
  config.saveConfig({ bot: { selfId: 10000001, masterId: 10000002 }, life: { enabled: false }, llm: { profiles: { default: { maxTokens: 400 } } } });
  const sent = [];
  const qqScheduler = new Scheduler({ llm, client: { selfId: 10000001, sendPrivateMsg: async (peer, text) => {
    sent.push(text); return { message_id: "greeting-complete" };
  } } });
  answer = () => calls.length === 1
    ? { role: "assistant", content: "刚才去收被子的时候，闻到上面晒", finish_reason: "length" }
    : "刚才去收被子的时候，闻到上面晒过太阳的味道。今晚也要好好休息。";
  const before = db.one("select count(*) as n from llm_usage where task='intent' and status='ok'").n;
  const result = await qqScheduler.compose({ peerId: "10000002", kind: "night", occasion: "晚安" });
  assert.equal(calls[0].max_tokens, 400);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].max_tokens > calls[0].max_tokens);
  assert.equal(result.text, "刚才去收被子的时候，闻到上面晒过太阳的味道。今晚也要好好休息。");
  assert.equal(db.one("select count(*) as n from llm_usage where task='intent' and status='ok'").n - before, 2);
  await qqScheduler.deliver({ peerId: "10000002", text: result.text, kind: "night", generation: result.generation });
  assert.deepEqual(sent, [result.text]);
  assert.equal(db.one("select body from outgoing where platform_message_id='greeting-complete'").body, result.text);
  const outgoing = db.one("select idempotency_key from outgoing where platform_message_id='greeting-complete'");
  assert.equal(db.one("select body from messages where event_key=?", ["out:" + outgoing.idempotency_key]).body, result.text);
  qqScheduler.stop();
});

test("normal ellipsis is not treated as truncation and scheduled output has no hard character cut", async () => {
  const text = "嗯……我还在这里。".repeat(50) + "等你回来。";
  answer = () => text;
  const result = await scheduler.compose({ peerId: localPeer("fixture"), kind: "night" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].max_tokens, 1000, "主动消息应遵守用户设置，不再暗中压到400 tokens");
  assert.equal(result.text, text);
});

test("length retry is bounded and never sends or stores a half reply", async () => {
  answer = () => ({ role: "assistant", content: "刚才去收被子的时候，闻到上面晒", finish_reason: "length" });
  const result = await chat.local.send(payload("想听你说晒被子的事"));
  assert.equal(result.state, "failed");
  assert.match(result.reason, /不完整|半句话/);
  assert.equal(calls.length, 3);
  assert.equal(chat.local.history().messages.filter(m => m.direction === "out").length, 0);
});

test("length retry respects budget denial and does not fall back to sending the partial text", async () => {
  let reserved = 0, settled = 0;
  const gateway = new LlmGateway({ budgetGate: {
    reserve: () => ++reserved === 1 ? { ok: true, reservationId: "first" } : { ok: false, reason: "合成预算不足" },
    settle: () => settled++, release() {},
  } });
  answer = () => ({ role: "assistant", content: "还没说", finish_reason: "length" });
  await assert.rejects(gateway.speak(config.activeCharacter(), "你好"), e => e.kind === "budget");
  assert.equal(calls.length, 1);
  assert.equal(settled, 1);
});

test("a clear during a length retry prevents old output from reappearing", async () => {
  const gate = deferred();
  answer = () => {
    if (calls.length === 1) {
      blockModel = gate;
      return { role: "assistant", content: "没说完的", finish_reason: "length" };
    }
    return "不应恢复的旧回复。";
  };
  const pending = chat.local.send(payload("你好"));
  await until(() => calls.length === 2);
  await chat.clearConversation(localScope("fixture"));
  gate.resolve(); blockModel = null;
  const result = await pending;
  assert.notEqual(result.state, "done");
  assert.equal(chat.local.history().messages.length, 0);
});

test("length recovery retains character and completed tools without replaying side effects", async () => {
  const character = { ...config.activeCharacter(), persona: "我是指挥官的妻子，称他提督。", speechStyle: "克制而理性。", boundaries: "RELATIONSHIP_TAIL" };
  let executed = 0;
  answer = () => calls.length === 1
    ? { role: "assistant", content: null, tool_calls: [{ id: "side-effect", type: "function", function: { name: "note", arguments: "{}" } }] }
    : calls.length === 2 ? { role: "assistant", content: "提督，我已经记", finish_reason: "length" }
    : "提督，我已经记好了。";
  const tools = [{ type: "function", function: { name: "note", parameters: { type: "object", properties: {} } } }];
  const result = await llm.speakWithTools(character, "记下约定", {
    tools, runTool: async () => { executed++; return { content: "已记下约定" }; },
    requestPatch: body => ({ ...body, tools, tool_choice: "auto" }),
  });
  assert.equal(executed, 1);
  assert.equal(result.text, "提督，我已经记好了。");
  assert.equal(result.finishReason, "stop");
  assert.equal(result.usage.calls, 3);
  assert.equal(result.usage.tokensOut, 30);
  assert.equal(calls[2].tools, undefined);
  assert.equal(calls[2].tool_choice, undefined);
  assert.ok(calls[2].messages.some(m => m.role === "tool" && m.content.includes("已记下约定")));
  assert.match(calls[2].messages[0].content, /妻子/);
  assert.match(calls[2].messages[0].content, /RELATIONSHIP_TAIL/);
  assert.equal(calls[2].messages.filter(m => m.role === "user").length, 1);
});

test("truncated tool arguments are never executed", async () => {
  let executed = 0;
  answer = () => ({ role: "assistant", content: null, finish_reason: "length", tool_calls: [
    { id: "broken", type: "function", function: { name: "note", arguments: '{"text":"' } },
  ] });
  await assert.rejects(llm.speakWithTools(config.activeCharacter(), "记下", { runTool: async () => { executed++; } }), e => e.kind === "truncated");
  assert.equal(executed, 0);
  assert.equal(calls.length, 1);
});

test("daily-open API is authorized, persists opt-in/channel and delivers once without blocking panel startup", async () => {
  db.run("delete from job_runs where job_key like 'first-open:%'");
  db.run("delete from outgoing where idempotency_key like 'first-open:%'");
  assert.equal((await request("/api/schedule/open", {}, false)).status, 401);
  assert.equal((await request("/api/schedule/first-open", { enabled: true, channel: "invalid" })).status, 400);
  assert.equal(config.getConfig().greet.firstOpen.enabled, false);
  const saved = await request("/api/schedule/first-open", { enabled: true, channel: "local" });
  assert.equal(saved.status, 200);
  assert.equal((await request("/api/schedule")).body.firstOpen.enabled, true);
  const gate = deferred();
  blockModel = gate;
  const started = await request("/api/schedule/open", {});
  assert.equal(started.status, 202);
  await until(() => calls.length === 1);
  assert.equal(db.one("select count(*) as n from messages where scope_key = ?", [localScope("fixture")]).n, 0);
  gate.resolve(); blockModel = null;
  await scheduler.openGreetingTask;
  assert.equal(db.one("select count(*) as n from messages where scope_key = ?", [localScope("fixture")]).n, 1);
  assert.match(calls[0].messages.map(m => m.content).join("\n"), /今天第一次打开心语/);
  await request("/api/schedule/open", {});
  await scheduler.openGreetingTask;
  assert.equal(calls.length, 1);
  assert.equal(qqSends, 0);
});

test("native ABCD burst is one complete model turn with every input stored once", async () => {
  config.saveConfig({ chat: { privateMergeWindowSec: 1, privateMaxWaitSec: 5, rememberFacts: false } });
  const parts = ["A:今天准备去看海", "B:但下午有雨", "C:我想改到明天", "D:所以今天先整理照片"];
  const jobs = [];
  for (const text of parts) {
    const accepted = await request("/api/chat/local", { ...payload(text), wait: false });
    assert.equal(accepted.body.ok, true, JSON.stringify(accepted.body));
    jobs.push(accepted.body.requestId);
  }
  assert.equal(calls.length, 0, "必须等用户说完，不能立即生成第一条回复");
  await until(() => chat.local.history().turns.filter(t => jobs.includes(t.request_id)).every(t => t.state === "done"));
  assert.equal(calls.length, 1);
  const users = calls[0].messages.filter(m => m.role === "user");
  assert.equal(users.length, 1, "ABCD必须作为同一轮完整输入，不能重复塞入历史");
  for (const text of parts) assert.equal(users[0].content.split(text).length - 1, 1);
  assert.equal(chat.local.history().messages.filter(m => m.direction === "in").length, 4);
  assert.equal(chat.local.history().messages.filter(m => m.direction === "out").length, 1);
});

test("native input during generation supersedes the old reply and completes every accepted message", async () => {
  const gate = deferred(); blockModel = gate;
  const jobs = [chat.local.send(payload("A:我想今天出发"))];
  await until(() => calls.length === 1);
  for (const text of ["B:等等，下午会下雨", "C:还是改成明天吧", "D:帮我按明天安排"]) jobs.push(chat.local.send(payload(text)));
  gate.resolve(); blockModel = null;
  const results = await Promise.all(jobs);
  assert(results.every(result => result.state === "done"), JSON.stringify(results));
  assert.equal(calls.length, 2, "只废弃旧生成并整体重算一次，不逐条处理B、C、D");
  assert.equal(chat.local.history().messages.filter(m => m.direction === "out").length, 1);
  const text = calls[1].messages.filter(m => m.role === "user").map(m => m.content).join("\n");
  for (const marker of ["A:", "B:", "C:", "D:"]) assert.equal(text.split(marker).length - 1, 1);
});

test("authenticated native chat works without QQ, uses the real model gateway and persists idempotently across DB reopen", async () => {
  const body = payload("明天别忘了陪我整理照片");
  assert.equal((await request("/api/chat/local", body, false)).status, 401);
  assert.equal(calls.length, 0);
  const result = await request("/api/chat/local", body);
  assert.equal(result.body.state, "done", JSON.stringify(result));
  assert.equal(calls.length, 1);
  assert.ok(JSON.stringify(calls[0]).includes("LOCAL_PROFILE_ONLY"));
  const history = (await request("/api/chat/local")).body;
  assert.equal(history.messages.length, 2);
  assert.equal(history.scopeKey, localScope("fixture"));
  assert.equal(
    db.one("select account_id from message_origins where scope_key = ?", [history.scopeKey]).account_id,
    LOCAL_ACCOUNT_ID,
  );
  assert.ok(
    life.getRelationship({
      characterId: "fixture",
      accountId: LOCAL_ACCOUNT_ID,
      contextId: history.scopeKey,
      subjectId: localPeer("fixture"),
    }).familiarity > 0,
  );
  assert.ok(life.listGoals({ scopeKey: history.scopeKey }).some((row) => row.content.includes("照片")));
  const again = await request("/api/chat/local", body);
  assert.equal(again.body.duplicate, true);
  assert.equal(calls.length, 1);
  db.closeDb();
  db.getDb();
  assert.equal(chat.local.history().messages.length, 2);
  assert.equal((await request("/api/chat/local", body)).body.duplicate, true);
});

test("quick memories, automatic archive, reflection and diary feed the next native conversation without crossing characters or QQ", async () => {
  assert.equal((await chat.local.send(payload("记住：我喜欢海边散步"))).state, "done");
  assert.equal(calls.length, 0);
  assert.equal((await chat.local.send(payload("你记得我喜欢什么吗"))).state, "done");
  assert.ok(JSON.stringify(calls[0]).includes("我喜欢海边散步"));
  answer = () =>
    JSON.stringify({
      summary: "一起约好了海边散步",
      experiences: [{ text: "我们约好了去海边散步", importance: 0.8 }],
      facts: [],
    });
  const archived = await life.archiveOnce({
    llm,
    character: config.activeCharacter(),
    force: true,
    scopeKey: localScope("fixture"),
  });
  assert.equal(archived.results[0].experiences, 1);
  memory.rememberQuick({
    scopeKey: localScope("fixture"),
    text: "我们约好明天去海边",
    peerId: localPeer("fixture"),
    characterId: "fixture",
  });
  answer = () =>
    JSON.stringify({ reflections: [{ text: "一起散步让我期待明天", evidence: [1, 2, 3], confidence: 0.9 }] });
  const reflected = await life.reflect({ llm, character: config.activeCharacter(), scopeKey: localScope("fixture") });
  assert.equal(reflected.created.length, 1);
  answer = () => "今天和对方约好了海边散步，我很期待。";
  const diary = await life.writeDiary({ llm, character: config.activeCharacter(), force: true });
  assert.equal(diary.skipped, false);
  assert.ok(life.diaryPromptBlock({ characterId: "fixture", scopeKey: localScope("fixture") }).includes("海边"));
  assert.equal(life.diaryPromptBlock({ characterId: "fixture", scopeKey: "private_123456" }), "");
  config.saveConfig({ activeCharacter: "second" });
  calls.length = 0;
  await chat.local.send(payload("你好呀"));
  assert.ok(!JSON.stringify(calls).includes("海边散步"));
  assert.equal(memory.pinnedFacts({ scopeKey: localScope("second") }).length, 0);
  const card = config.loadCharacter("fixture");
  assert.equal(
    privateUserProfile(card, { kind: "private", peerId: "123456", accountId: "999999", scopeKey: "private_123456" }),
    null,
  );
  assert.equal(
    privateUserProfile(card, {
      kind: "private",
      peerId: localPeer("second"),
      accountId: LOCAL_ACCOUNT_ID,
      scopeKey: localScope("second"),
    }),
    null,
  );
});

test("native attachments reach the model and remain readable after reload, with no protocol downloads", async () => {
  const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=";
  const result = await chat.local.send(
    payload("读一下图片与文件", {
      images: [png],
      files: [
        { name: "note.txt", dataUrl: "data:text/plain;base64," + Buffer.from("原生附件中的文字").toString("base64") },
      ],
    }),
  );
  assert.equal(result.state, "done", JSON.stringify(result));
  assert.ok(JSON.stringify(calls).includes("原生附件中的文字"));
  assert.ok(JSON.stringify(calls).includes("data:image/png;base64,"));
  const message = chat.local.history().messages[0];
  const url = base + "/api/chat/local/media?messageId=" + message.id + "&index=0";
  assert.equal((await fetch(url)).status, 401);
  const image = await fetch(url, { headers: { Authorization: "Bearer " + token } });
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), Buffer.from(png.split(",")[1], "base64"));
  await assert.rejects(chat.local.send(payload("bad", { images: ["file:///C:/secret.png"] })), /附件格式/);
});

test("native async submission acknowledges a stored turn while the model is still busy", async () => {
  blockModel = deferred();
  const body = payload("慢慢回复也没关系", { wait: false });
  try {
    const accepted = await request("/api/chat/local", body);
    assert.equal(accepted.status, 202);
    assert.equal(accepted.body.accepted, true);
    assert.equal(accepted.body.state, "processing");
    await until(() => calls.length === 1);
    assert.equal(chat.local.history().messages[0].body, body.text);
    assert.equal(chat.local.history().turns[0].state, "processing");
    const duplicate = await request("/api/chat/local", body);
    assert.equal(duplicate.body.duplicate, true);
    assert.equal(calls.length, 1);
  } finally {
    blockModel.resolve();
    await until(() => !chat.busy.has(localScope("fixture")));
  }
  assert.equal(chat.local.history().turns[0].state, "done");
});

test("custom chat backgrounds persist per character and require panel authentication", async () => {
  const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=";
  assert.equal((await request("/api/chat/background", { characterId: "fixture", dataUrl: png }, false)).status, 401);
  const saved = (await request("/api/chat/background", { characterId: "fixture", dataUrl: png })).body;
  assert.ok(saved.background.url.includes("fixture"));
  assert.equal((await request("/api/chat/background?characterId=second")).body.background, null);
  const url = base + saved.background.url;
  assert.equal((await fetch(url)).status, 401);
  const read = await fetch(url, { headers: { Authorization: "Bearer " + token } });
  assert.equal(read.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await read.arrayBuffer()), Buffer.from(png.split(",")[1], "base64"));
  const reloaded = (await request("/api/chat/background?characterId=fixture")).body;
  assert.equal(reloaded.background.url, saved.background.url);
  assert.equal(
    (await request("/api/chat/background", { dataUrl: "data:image/svg+xml;base64,PHN2Zy8+" })).body.ok,
    false,
  );
  assert.equal((await request("/api/chat/background", { characterId: "fixture", clear: true })).body.background, null);
  assert.equal((await fetch(url, { headers: { Authorization: "Bearer " + token } })).status, 404);
});

test("one-click memory previews are non-destructive and local mode archives without Docker or external memory services", async () => {
  const preview = (await request("/api/next/memory/prepare", { mode: "local" })).body;
  assert.equal(preview.ok, true);
  assert.equal(config.getConfig().nextMemory.enabled, false, "preview must not enable or disable any existing service");
  assert.equal(preview.disclosure.destinations.length, 1);
  assert.ok(!JSON.stringify(preview).includes("mock-only"));
  assert.equal((await request("/api/next/memory/enable", { fingerprint: "stale", agreed: true })).body.ok, false);
  const enabled = (
    await request("/api/next/memory/enable", { fingerprint: preview.disclosure.fingerprint, agreed: true })
  ).body;
  assert.equal(enabled.ok, true);
  assert.equal(config.getConfig().nextMemory.mode, "local");
  await chat.local.send(payload("昨天一起去了海边"));
  db.run("update messages set at = at - 86400000 where scope_key = ?", [localScope("fixture")]);
  answer = () => JSON.stringify({ summary: "昨天一起去海边散步" });
  const archived = await extended.archiveExtendedDaily(llm);
  assert.equal(archived.ok, true);
  assert.ok(extended.listExtendedMemories().some((row) => row.content.includes("海边散步")));
  answer = () => "记得呀，昨天一起去了海边。";
  calls.length = 0;
  await chat.local.send(payload("回忆一下昨天的事情"));
  assert.ok(JSON.stringify(calls).includes("本机长期记忆"));
  assert.ok(JSON.stringify(calls).includes("昨天一起去海边散步"));
  const enhanced = (await request("/api/next/memory/prepare", { mode: "hindsight" })).body;
  assert.equal(enhanced.ok, true);
  assert.equal(
    config.getConfig().nextMemory.enabled,
    true,
    "cancelling an enhancement preview must preserve the active service",
  );
  assert.equal(config.getConfig().nextMemory.mode, "local");
  assert.match(enhanced.disclosure.destinations[0].baseUrl, /^http:\/\/127\.0\.0\.1:[1-9]\d+$/);
  assert.equal((await request("/api/next/memory/disable", {})).body.ok, true);
});

test("managed Hindsight automatically replaces stale container configuration and preserves its data volume", async () => {
  config.saveConfig({
    nextMemory: {
      enabled: true,
      mode: "hindsight",
      managed: true,
      baseUrl: managedHindsightUrl(),
      apiKey: "fixture-local-auth",
      llm: { baseUrl: modelUrl, apiKey: "mock-only", model: "fixture" },
    },
  });
  config.saveConfig({ nextMemory: { consentDigest: extended.memoryDisclosure().fingerprint } });
  const name = "heartecho-memory-" + digest(path.join(tmp, "data")).slice(0, 12);
  let exists = true;
  const operations = [];
  const result = await startManagedHindsight({
    runDocker: async (args) => {
      operations.push(args);
      if (args[0] === "ps") return exists ? name : "";
      if (args[0] === "inspect") return "old-config";
      if (args[0] === "rm") exists = false;
      return "fixture";
    },
    probe: async (url, options) => {
      assert.equal(url, managedHindsightUrl() + "/health");
      assert.equal(options.apiKey, "fixture-local-auth");
      return {};
    },
  });
  assert.equal(result.ok, true);
  assert.ok(operations.some((args) => args[0] === "stop"));
  assert.deepEqual(
    operations.find((args) => args[0] === "rm"),
    ["rm", name],
  );
  const run = operations.find((args) => args[0] === "run");
  assert.ok(run.includes(name + ":/home/hindsight/.pg0"));
  assert.ok(run.includes("127.0.0.1:" + new URL(managedHindsightUrl()).port + ":8888"));
  assert.equal(fs.existsSync(path.join(tmp, "data", "hindsight-runtime", "service.env")), false);
});

test("native daily long-term memory supports offline recall, explicit role sharing and revocation without inheriting QQ identity", async () => {
  await chat.local.send(payload("昨天一起看了海边日出"));
  const scopeKey = localScope("fixture");
  db.run("update messages set at = at - 86400000 where scope_key = ?", [scopeKey]);
  config.saveConfig({ nextMemory: { enabled: true, consentDigest: "", characterLinks: [] } });
  config.saveConfig({ nextMemory: { consentDigest: extended.memoryDisclosure().fingerprint } });
  answer = () => JSON.stringify({ summary: "昨天一起看过海边日出，约定下次再见。" });
  await extended.archiveExtendedDaily(llm);
  const record = extended.listExtendedMemories().find((row) => row.scope_key === scopeKey);
  assert.ok(record);
  assert.equal(record.account_id, LOCAL_ACCOUNT_ID);
  answer = () => "记得呀，那次一起看海很开心。";
  calls.length = 0;
  await chat.local.send(payload("回忆一下昨天发生的事"));
  assert.ok(JSON.stringify(calls).includes("昨天一起看过海边日出"));
  const qq = { kind: "private", accountId: "123456", senderId: "234567", scopeKey: "private_234567" };
  assert.equal(extended.canRecallRecord(record, qq, "fixture"), false);
  const other = {
    kind: "private",
    accountId: LOCAL_ACCOUNT_ID,
    senderId: localPeer("second"),
    scopeKey: localScope("second"),
  };
  assert.equal(extended.canRecallRecord(record, other, "second"), false);
  config.saveConfig({ nextMemory: { characterLinks: [["fixture", "second"]] } });
  assert.equal(extended.canRecallRecord(record, other, "second"), true);
  assert.equal(extended.memoryGrantCommand({ ...other, text: "授权记忆到群 123456" }, "second"), null);
  config.saveConfig({ nextMemory: { characterLinks: [] } });
  assert.equal(extended.canRecallRecord(record, other, "second"), false);
  await chat.clearConversation(scopeKey);
  assert.equal(
    extended.canRecallRecord(record, { ...other, senderId: localPeer("fixture"), scopeKey }, "fixture"),
    false,
  );
});

test("clear and character switches fence in-flight native requests and never restore deleted messages", async () => {
  blockModel = deferred();
  const first = payload("这条会被清空");
  const sending = chat.local.send(first);
  await until(() => calls.length === 1);
  await chat.clearConversation(localScope("fixture"));
  blockModel.resolve();
  assert.equal((await sending).state, "cancelled");
  assert.equal(chat.local.history().messages.length, 0);
  await assert.rejects(chat.local.send(first), /会话已清空/);
  blockModel = deferred();
  calls.length = 0;
  const switching = chat.local.send(payload("切换角色前的请求"));
  await until(() => calls.length === 1);
  config.saveConfig({ activeCharacter: "second" });
  blockModel.resolve();
  assert.equal((await switching).replied, false);
  assert.equal(chat.local.history("fixture").messages.filter((m) => m.direction === "out").length, 0);
  await assert.rejects(chat.local.send({ ...payload("旧角色"), characterId: "fixture" }), /角色已切换/);
});

test("greetings, reminders and follow-ups can deliver into inactive characters' native histories without QQ", async () => {
  await chat.local.send(payload("你好"));
  const peer = localPeer("fixture"),
    scopeKey = localScope("fixture");
  assert.equal(scheduler.defaultTarget(), peer);
  await scheduler.greetNow({ userId: peer, text: "早上好", kind: "morning" });
  const reminder = addReminder({ targetId: peer, text: "吃药提醒", at: Date.now() - 100, polish: false });
  config.saveConfig({ activeCharacter: "second" });
  assert.equal((await scheduler.tickReminders(new Date())).length, 1);
  assert.equal(db.one("select enabled from reminders where id = ?", [reminder.id]).enabled, 0);
  assert.ok(chat.local.history("fixture").messages.some((m) => m.body === "吃药提醒" && m.sender_name === "小语"));
  assert.equal(chat.local.history("second").messages.length, 0);
  const generation = chat.local.history("fixture").generation;
  const composed = await scheduler.compose({ peerId: peer, occasion: "follow-up", kind: "followup" });
  await chat.clearConversation(scopeKey);
  assert.equal(await scheduler.deliver({ peerId: peer, text: composed.text, kind: "followup", generation }), null);
  assert.equal(chat.local.history("fixture").messages.length, 0);
});

test("the actual extension host and function-calling loop send native tool messages and preserve the native identity", async () => {
  const host = new ExtensionHost({ llm, client, engine: chat, dataDir: path.join(tmp, "extension-tools") });
  const entry = host.tools.register("fixture", {
    id: "native_note",
    description: "发送本地工具消息",
    parameters: {},
    execute: async (ctx) => {
      assert.equal(ctx.selfId, LOCAL_ACCOUNT_ID);
      assert.equal(ctx.chatKey, "private:" + localPeer("fixture"));
      await ctx.sender.sendText(ctx.chatKey, "工具送来的消息");
      return "已送达心语会话";
    },
  });
  host.extensions.set("fixture", { ok: true, enabled: true, available: { ok: true }, tools: [entry] });
  chat.extensions = host;
  answer = (body) =>
    body.messages.some((m) => m.role === "tool")
      ? "我已经把消息送到这里啦。"
      : {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call-native", type: "function", function: { name: entry.name, arguments: "{}" } }],
        };
  const result = await chat.local.send(payload("用工具给我留条消息"));
  assert.equal(result.state, "done", JSON.stringify(result));
  const history = chat.local.history().messages;
  assert.equal(history.length, 3);
  assert.equal(history[1].body, "工具送来的消息");
  assert.ok(calls[0].tools.some((tool) => tool.function.name === entry.name));
  assert.equal(calls.length, 2);
  answer = () => ({
    role: "assistant",
    content: null,
    tool_calls: [{ id: "call-end", type: "function", function: { name: "finish", arguments: "{}" } }],
  });
  const silent = await chat.local.send(payload("这轮先不说话，结束就好"));
  assert.equal(silent.state, "done");
  assert.equal(calls.length, 3, "finish must stop after one extra model request");

  const relationship = () =>
    life.getRelationship({
      characterId: "fixture",
      accountId: LOCAL_ACCOUNT_ID,
      contextId: localScope("fixture"),
      subjectId: localPeer("fixture"),
    });
  const familiarity = relationship().familiarity;
  answer = (body) => ({
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "call-only-tool-" + calls.length,
        type: "function",
        function: { name: body.messages.at(-1).role === "tool" ? "finish" : entry.name, arguments: "{}" },
      },
    ],
  });
  const toolOnly = await chat.local.send(payload("明天记得用工具给我留条消息，然后结束"));
  assert.equal(toolOnly.state, "done", JSON.stringify(toolOnly));
  assert.equal(calls.length, 5, "a tool delivery followed by finish must not request another model reply");
  assert.equal(chat.local.history().messages.at(-1).body, "工具送来的消息");
  assert.ok(relationship().familiarity > familiarity, "tool-only replies must update the relationship");
  assert.ok(
    life.listGoals({ scopeKey: localScope("fixture") }).some((row) => row.content.includes("用工具给我留条消息")),
    "tool-only replies must record commitments",
  );
});

test("extension images/text use native history and obey local target and generation boundaries", async () => {
  const scopeKey = localScope("fixture"),
    chatKey = "private:" + localPeer("fixture");
  await chat.sendExtensionMessage({
    scopeKey,
    chatKey,
    text: "插件送来一张图",
    image: { dataUrl: "data:image/png;base64,YQ==" },
  });
  const row = chat.local.history().messages[0];
  assert.equal(row.body, "插件送来一张图");
  assert.ok(row.attachments_json.includes("data:image/png;base64,"));
  await assert.rejects(
    chat.sendExtensionMessage({ scopeKey: localScope("second"), chatKey, text: "错误目标" }),
    /本地消息/,
  );
  await assert.rejects(
    chat.sendExtensionMessage({ scopeKey, chatKey, text: "已过期", validity: () => false }),
    /会话已变更/,
  );
});

test("native UI parses, escapes messages and retains the selected character's draft", () => {
  new vm.Script(APP_JS);
  const context = {
    URLSearchParams,
    location: { hash: "", pathname: "/", search: "" },
    window: { addEventListener() {} },
    document: { documentElement: { setAttribute() {} }, addEventListener() {} },
  };
  vm.createContext(context);
  vm.runInContext(APP_JS, context);
  const html = vm.runInContext(
    'nativeMessageHtml({direction:"out",sender_name:"小语",body:"<script>bad</script>",at:1,attachments_json:"[]"})',
    context,
  );
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("<script>"));
});
