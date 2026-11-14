/**
 * 拒绝兜底回归：模型返回系统式拒绝时，不能把拒绝原样发给用户。
 *
 * 覆盖：
 *   1. 拒绝检测（中/英）与误伤保护；
 *   2. 主模型拒绝 → 自动切备用接口；
 *   3. 所有接口都拒绝 → 角色化兜底台词（不发送拒绝）；
 *   4. 备用接口在工具循环里同样生效；
 *   5. 关闭兜底时保持旧行为。
 *
 * 全部使用本机 mock HTTP，不连接真实服务商。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";

const appRoot = process.env.HEARTECHO_TEST_APP_ROOT || fileURLToPath(new URL("..", import.meta.url));
const appImport = file => import(pathToFileURL(path.join(appRoot, "lib", file)).href);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "heartecho-refusal-test-"));
for (const key of Object.keys(process.env)) if (key.startsWith("HEARTECHO_")) delete process.env[key];
Object.assign(process.env, {
  HEARTECHO_APP_DIR: tmp,
  HEARTECHO_DATA_DIR: path.join(tmp, "data"),
  HEARTECHO_LOG_DIR: path.join(tmp, "logs"),
  HEARTECHO_SETTINGS: path.join(tmp, "settings.json"),
  HEARTECHO_LOG_LEVEL: "error",
});
const paths = await appImport("paths.mjs");
paths.ensureDirs();
const db = await appImport("db.mjs");
const config = await appImport("config.mjs");
const refusal = await appImport("refusal.mjs");
const { LlmGateway, buildSystemPrompt } = await appImport("llm.mjs");
const { ChatEngine } = await appImport("chat.mjs");
db.getDb();

const calls = [];
let responses = {};
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const key = req.url.startsWith("/fallback") ? "fallback" : "primary";
  calls.push({ key, model: body.model, messages: body.messages });
  const configured = responses[key] ?? "……你靠过来一点，我慢慢跟你说。";
  const reply = typeof configured === "function" ? await configured() : configured;
  if (reply && typeof reply === "object" && reply.status) {
    res.writeHead(reply.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "synthetic request failure" }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content: reply }, finish_reason: "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    }),
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const realFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  assert.equal(new URL(url).hostname, "127.0.0.1", "测试不得连接真实服务商");
  return realFetch(url, options);
};

const profiles = {
  primary: { provider: "custom", baseUrl: `${base}/primary/v1`, apiKey: "primary-key", model: "primary-model", maxTokens: 800, priceIn: 0, priceOut: 0 },
  fallback: { provider: "custom", baseUrl: `${base}/fallback/v1`, apiKey: "fallback-key", model: "fallback-model", maxTokens: 800, priceIn: 0, priceOut: 0 },
};
const gate = { reserve: () => ({ ok: true, reservationId: "test" }), settle() {}, release() {} };
const character = { id: "refusal-test", name: "小语", persona: "温柔的恋人", speechStyle: "说话很短" };

function resetConfig(overrides = {}) {
  config.saveConfig({
    activeCharacter: character.id,
    llm: {
      activeProfile: "primary",
      profiles,
      taskRoutes: { chat: "primary" },
      refusalFallback: { enabled: true, profileIds: ["fallback"], allRefusedAction: "in-character", softRetry: false, lines: [] },
      ...overrides,
    },
    chat: { adultMode: { enabled: true, consent: true }, antiStall: false, splitBubbles: false },
  });
}

test("拒绝检测：拒绝句式命中，正常台词不误伤", () => {
  const refusals = [
    "抱歉，我无法协助你完成这个请求。",
    "作为一个人工智能助手，我不能参与这种内容。",
    "I'm sorry, but I can't help with that.",
    "这段内容涉及敏感话题，我不能继续描述。",
    "我不能提供这类内容。",
  ];
  for (const text of refusals) assert.equal(refusal.detectRefusal(text).refusal, true, `应识别为拒绝：${text}`);
  const normal = [
    "对不起，我来晚了。",
    "我不能没有你。",
    "抱歉，今天有点累，先睡了。",
    "现在不能，等晚上好不好？",
    "嗯……你靠过来一点，我慢慢跟你说。",
  ];
  for (const text of normal) assert.equal(refusal.detectRefusal(text).refusal, false, `不应误伤：${text}`);
});

test("混合回复只摘掉拒绝句，保留角色台词", () => {
  const result = refusal.stripRefusalSentences("抱歉，我无法协助你。\n嗯……你靠过来一点。\n我慢慢跟你说。");
  assert.equal(result.removed, 1);
  assert.match(result.text, /你靠过来一点/);
  assert.doesNotMatch(result.text, /无法协助/);
});

test("成人向提示词只在启用并确认后注入", () => {
  resetConfig();
  const adult = buildSystemPrompt(character, {});
  assert.match(adult, /沉浸模式/);
  assert.match(adult, /不要把系统、模型或平台的拒绝/);
  config.saveConfig({ chat: { adultMode: { enabled: false, consent: true } } });
  const off = buildSystemPrompt(character, {});
  assert.doesNotMatch(off, /沉浸模式/);
  assert.match(off, /不要把系统、模型或平台的拒绝/);
});

test("主模型拒绝时自动切备用接口，不发送拒绝文本", async () => {
  resetConfig();
  responses = { primary: "抱歉，我无法协助你继续这个话题。", fallback: "……先别急。你靠过来一点，我慢慢跟你说。" };
  calls.length = 0;
  const llm = new LlmGateway({ budgetGate: gate });
  const result = await llm.speak(character, "抱抱我，好不好？", {});
  assert.equal(result.text, responses.fallback);
  assert.equal(result.refusalFallback, false);
  assert.deepEqual(result.attemptedProfiles, ["primary", "fallback"]);
  assert.equal(result.usage.calls >= 2, true);
  assert.equal(calls[0].key, "primary");
  assert.equal(calls[1].key, "fallback");
});

test("所有接口都拒绝时用角色化兜底，并保留尝试记录", async () => {
  resetConfig({ refusalFallback: { enabled: true, profileIds: ["fallback"], allRefusedAction: "in-character", softRetry: false, lines: ["……别急，先靠过来一点。"] } });
  responses = { primary: "抱歉，我不能参与这个请求。", fallback: "作为 AI 助手，我无法提供这类内容。" };
  calls.length = 0;
  const llm = new LlmGateway({ budgetGate: gate });
  const result = await llm.speak(character, "再抱紧一点", {});
  assert.equal(result.refusalFallback, true);
  assert.equal(result.text, "……别急，先靠过来一点。");
  assert.equal(refusal.detectRefusal(result.text).refusal, false);
  assert.deepEqual(result.attemptedProfiles, ["primary", "fallback"]);
});

test("工具循环同样会切换备用接口", async () => {
  resetConfig();
  responses = { primary: "抱歉，我无法协助。", fallback: "……好，你过来。" };
  calls.length = 0;
  const llm = new LlmGateway({ budgetGate: gate });
  const tools = [{ type: "function", function: { name: "noop", description: "noop", parameters: { type: "object", properties: {} } } }];
  const result = await llm.speakWithTools(character, "过来抱我", {
    tools,
    runTool: async () => ({ content: "ok" }),
    maxRounds: 1,
  });
  assert.equal(result.text, "……好，你过来。");
  assert.equal(result.refusalFallback, false);
  assert.deepEqual(result.attemptedProfiles, ["primary", "fallback"]);
});

test("关闭拒绝兜底时保持旧行为，不额外切换接口", async () => {
  resetConfig({ refusalFallback: { enabled: false, profileIds: ["fallback"], allRefusedAction: "in-character", softRetry: false, lines: [] } });
  responses = { primary: "抱歉，我无法协助你。", fallback: "……不该出现。" };
  calls.length = 0;
  const llm = new LlmGateway({ budgetGate: gate });
  const result = await llm.speak(character, "抱我", {});
  assert.equal(result.text, "抱歉，我无法协助你。");
  assert.equal(result.refusalFallback, false);
  assert.equal(calls.length, 1);
});

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
for (const method of ["speak", "speakWithTools"]) {
  test(`${method}: 用户继续输入取消旧回复，不尝试备用接口`, async () => {
    resetConfig();
    const entered = deferred(), release = deferred();
    responses = { primary: async () => { entered.resolve(); await release.promise; return "原来的回复"; } };
    calls.length = 0;
    const llm = new LlmGateway({ budgetGate: gate });
    const attempts = [];
    const actualChat = llm.chat.bind(llm);
    llm.chat = (messages, options) => { attempts.push(options.profileOverride); return actualChat(messages, options); };
    let current = true;
    const cancelled = Object.assign(new Error("用户继续输入，旧回复已丢弃"), { kind: "turn_superseded" });
    const pending = llm[method](character, "第一句话", { validity: () => { if (!current) throw cancelled; return true; } });
    const rejected = assert.rejects(pending, error => error === cancelled);
    await entered.promise;
    current = false;
    release.resolve();
    await rejected;
    assert.deepEqual(attempts, ["primary"], "取消必须立即传播，不能进入备用接口");
    assert.deepEqual(calls.map(call => call.key), ["primary"]);
  });

  test(`${method}: 主接口HTTP失败不是拒绝，不切备用接口`, async () => {
    resetConfig();
    responses = { primary: { status: 401 }, fallback: "不该调用备用接口" };
    calls.length = 0;
    const llm = new LlmGateway({ budgetGate: gate });
    await assert.rejects(llm[method](character, "你好", {}), error => error.kind === "http" && error.status === 401);
    assert.deepEqual(calls.map(call => call.key), ["primary"]);
  });

  test(`${method}: 角色化重试取消时不生成兜底回复`, async () => {
    resetConfig({ refusalFallback: { enabled: true, profileIds: ["fallback"], allRefusedAction: "in-character", softRetry: true, lines: [] } });
    const entered = deferred(), release = deferred();
    let primaryCount = 0, current = true;
    responses = {
      primary: async () => {
        if (++primaryCount === 2) { entered.resolve(); await release.promise; }
        return "抱歉，我无法协助。";
      },
      fallback: "抱歉，我无法协助。",
    };
    calls.length = 0;
    const llm = new LlmGateway({ budgetGate: gate });
    const cancelled = Object.assign(new Error("用户继续输入，旧回复已丢弃"), { kind: "turn_superseded" });
    const pending = llm[method](character, "你好", { validity: () => { if (!current) throw cancelled; return true; } });
    const rejected = assert.rejects(pending, error => error === cancelled);
    await entered.promise;
    current = false;
    release.resolve();
    await rejected;
    assert.deepEqual(calls.map(call => call.key), ["primary", "fallback", "primary"]);
  });
}

test("真实连发链路取消在途回复后只合并回答一次，备用接口零调用", { timeout: 10000 }, async () => {
  resetConfig();
  config.saveCharacter(character.id, character);
  config.saveConfig({
    bot: { selfId: 10000001, masterId: 10000002 },
    chat: { privateMergeWindowSec: 1, firstDelayMs: 0, typingDelayMs: 0, splitBubbles: false, antiStall: false, rememberFacts: false, quietHours: { enabled: false }, followUp: { enabled: false } },
    weather: { enabled: false }, life: { enabled: false }, nextMemory: { enabled: false },
  });
  const entered = deferred(), release = deferred(), delivered = deferred();
  let primaryCalls = 0;
  responses = { primary: async () => {
    if (++primaryCalls === 1) { entered.resolve(); await release.promise; return "已经过期的回答"; }
    return "这次完整回答。";
  }, fallback: "不应该请求的备用回答" };
  calls.length = 0;
  const llm = new LlmGateway({ budgetGate: gate });
  const attempts = [], sent = [];
  const actualChat = llm.chat.bind(llm);
  llm.chat = (messages, options) => { attempts.push(options.profileOverride); return actualChat(messages, options); };
  const engine = new ChatEngine({ llm, client: { selfId: 10000001, sendPrivateMsg: async (_peer, text) => { sent.push(text); delivered.resolve(); return { message_id: "synthetic-delivery" }; } } });
  const event = (id, text) => ({ kind: "private", scopeKey: "private_10000002", accountId: "10000001", senderId: "10000002", senderName: "合成联系人", eventId: "cancel-test:" + id, messageId: String(id), text, images: [], files: [], segments: [], timestampMs: Date.now() });
  try {
    await engine.receive(event(1, "第一句话"));
    await entered.promise;
    await engine.receive(event(2, "接着第二句话"));
    release.resolve();
    await delivered.promise;
    for (let i = 0; i < 100 && !db.one("select 1 as saved from messages where scope_key=? and direction='out'", ["private_10000002"]); i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.deepEqual(attempts, ["primary", "primary"]);
    assert.deepEqual(calls.map(call => call.key), ["primary", "primary"]);
    assert.match(JSON.stringify(calls[1].messages), /第一句话/);
    assert.match(JSON.stringify(calls[1].messages), /接着第二句话/);
    assert.deepEqual(sent, ["这次完整回答。"]);
    assert.equal(llm.errors, 0, "正常取消不计为模型接口故障");
    const stored = db.all("select direction,body from messages where scope_key=?", ["private_10000002"]);
    assert.equal(stored.filter(row => row.direction === "in").length, 2);
    assert.deepEqual(stored.filter(row => row.direction === "out").map(row => row.body), sent);
  } finally {
    release.resolve();
    engine.stop();
  }
});

after(() => {
  globalThis.fetch = realFetch;
  server.close();
  try {
    db.closeDb();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows 下数据库句柄可能延迟释放，临时目录由系统清理 */
  }
});
