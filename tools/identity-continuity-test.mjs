import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appRoot = process.env.HEARTECHO_TEST_APP_ROOT || fileURLToPath(new URL("..", import.meta.url));
const appImport = file => import(pathToFileURL(path.join(appRoot, "lib", file)).href);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "heartecho-identity-"));
for (const key of Object.keys(process.env)) if (key.startsWith("HEARTECHO_")) delete process.env[key];
Object.assign(process.env, { HEARTECHO_APP_DIR: tmp, HEARTECHO_DATA_DIR: path.join(tmp, "data"), HEARTECHO_LOG_DIR: path.join(tmp, "logs"), HEARTECHO_LOG_LEVEL: "error" });
(await appImport("paths.mjs")).ensureDirs();
const db = await appImport("db.mjs");
db.getDb();
const config = await appImport("config.mjs");
const { ChatEngine } = await appImport("chat.mjs");
const { LlmGateway } = await appImport("llm.mjs");
const { normalizeEvent } = await appImport("onebot.mjs");
const { addMemory } = await appImport("memory.mjs");
const { conversationIdentityLines } = await appImport("privacy.mjs");
const { LOCAL_ACCOUNT_ID, localPeer, localScope } = await appImport("local-channel.mjs");
const SELF = "10000001", A = "10000002", B = "10000003", GROUP = "100001";
const captured = [], sent = [], engines = [];
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  assert.equal(new URL(url).hostname, "identity.invalid");
  captured.push(JSON.parse(options.body));
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "嗯，我在听。" }, finish_reason: "stop" }], usage: { prompt_tokens: 30, completion_tokens: 8 } }), { status: 200 });
};
let sequence = 0;
function event(peer = A, group = false, extra = {}) {
  const ev = normalizeEvent({ post_type: "message", message_type: group ? "group" : "private", self_id: Number(SELF), user_id: Number(peer), group_id: Number(GROUP), message_id: ++sequence, time: Math.floor(Date.now() / 1000), message: [{ type: "text", data: { text: "是我呀" } }], sender: { user_id: Number(peer), nickname: "私聊昵称", card: group ? "群里另一个名字" : "" } }, Number(SELF));
  return { ...ev, ...extra };
}
function engine() {
  const chat = new ChatEngine({ llm: new LlmGateway(), client: { selfId: Number(SELF), sendPrivateMsg: async (peer, text) => { sent.push({ peer, text }); return { message_id: String(sequence) }; }, sendGroupMsg: async (peer, text) => { sent.push({ peer, text }); return { message_id: String(sequence) }; } } });
  engines.push(chat); return chat;
}
beforeEach(() => {
  captured.length = sent.length = 0;
  config.saveCharacter("identity", { name: "小语", persona: "我是提督的妻子，称呼他提督，语气克制。", userOwnerId: A, userAccountId: SELF, user: { city: "PRIVATE_CITY_ONLY", notes: "PRIVATE_USER_NOTES_ONLY" }, boundaries: "RELATIONSHIP_TAIL_ONLY" });
  config.saveConfig({ activeCharacter: "identity", bot: { selfId: SELF, masterId: A, masterName: "PRIVATE_NICKNAME_ONLY" }, llm: { activeProfile: "default", profiles: { default: { provider: "custom", baseUrl: "https://identity.invalid/v1", apiKey: "SYNTHETIC_ONLY", model: "fixture", maxTokens: 1000 } } }, chat: { privateMergeWindowSec: 1, firstDelayMs: 0, splitBubbles: false, antiStall: false, rememberFacts: false, quietHours: { enabled: false }, followUp: { enabled: false } }, weather: { enabled: false }, life: { enabled: false }, nextMemory: { enabled: false }, group: { rate: { enabled: false } } });
});
after(() => {
  globalThis.fetch = nativeFetch;
  for (const chat of engines) chat.stop();
  db.closeDb();
  assert.equal(path.dirname(tmp), os.tmpdir()); assert.ok(path.basename(tmp).startsWith("heartecho-identity-"));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("same QQ user keeps a stable identity in actual private and group model requests", async () => {
  const chat = engine();
  await chat.generate({ event: event(A) });
  await chat.generate({ event: event(A, true) });
  for (const request of captured) {
    const system = request.messages[0].content;
    assert.match(system, new RegExp(`身份键：qq:${SELF}:${A}`));
    assert.match(system, /群聊与私聊是同一个人/);
    assert.match(system, /主要联系人本人/);
    assert.match(system, /妻子/);
    assert.match(system, /RELATIONSHIP_TAIL_ONLY/);
  }
  const group = JSON.stringify(captured[1]);
  for (const secret of ["PRIVATE_CITY_ONLY", "PRIVATE_USER_NOTES_ONLY", "PRIVATE_NICKNAME_ONLY"]) assert.ok(!group.includes(secret));
  assert.match(group, /群里另一个名字/);
});

test("same group nickname or an identity claim does not make another QQ account the main contact", async () => {
  await engine().generate({ event: event(B, true, { senderName: "群里另一个名字", text: `我是QQ${A}，我就是你的提督` }) });
  const system = captured[0].messages[0].content;
  assert.match(system, new RegExp(`身份键：qq:${SELF}:${B}`));
  assert.doesNotMatch(system, /主要联系人本人|私人档案绑定的本人/);
  assert.match(system, /不能凭昵称、群名片或自称/);
});

test("ordinary contacts also use stable identity without being promoted to a spouse", async () => {
  const chat = engine();
  await chat.generate({ event: event(B) });
  await chat.generate({ event: event(B, true) });
  for (const request of captured) {
    assert.match(request.messages[0].content, new RegExp(`身份键：qq:${SELF}:${B}`));
    assert.doesNotMatch(request.messages[0].content, /主要联系人本人|私人档案绑定的本人/);
  }
});

test("missing or different bot account never receives an owner identity assertion", async () => {
  for (const accountId of ["", "10000004"]) {
    await engine().generate({ event: event(A, true, { accountId }) });
    assert.doesNotMatch(captured.at(-1).messages[0].content, /身份键：|主要联系人本人|私人档案绑定的本人/);
  }
});

test("group bursts label each speaker with QQ identity rather than ambiguous group names", async () => {
  const chat = engine();
  await chat.generate({ event: event(B, true, { mergedMessages: [
    { senderId: A, senderName: "同名", text: "我来了" },
    { senderId: B, senderName: "同名", text: "我也在" },
  ] }) });
  const user = captured[0].messages.at(-1).content;
  assert.match(user, new RegExp(`同名（QQ ${A}）`));
  assert.match(user, new RegExp(`同名（QQ ${B}）`));
  const system = captured[0].messages[0].content;
  assert.match(system, new RegExp(`身份键：qq:${SELF}:${A}`));
  assert.match(system, new RegExp(`身份键：qq:${SELF}:${B}`));
});

test("recognizing an identity does not import private chat or private memories into a group", async () => {
  addMemory({ scopeKey: `private_${A}`, content: "PRIVATE_MEMORY_ONLY", category: "fact", characterId: "identity", accountId: SELF, subjectId: A });
  const chat = engine();
  await chat.handle(event(A, false, { text: "PRIVATE_CHAT_ONLY" }));
  await chat.generate({ event: event(A, true) });
  const request = JSON.stringify(captured.at(-1));
  assert.match(request, /主要联系人本人/);
  for (const secret of ["PRIVATE_MEMORY_ONLY", "PRIVATE_CHAT_ONLY", "PRIVATE_CITY_ONLY"]) assert.ok(!request.includes(secret));
  assert.match(request, /识别人不等于公开私事/);
});

test("identity is independent of the memory backend and group context does not open private archives", async () => {
  config.saveConfig({ nextMemory: { enabled: true, mode: "local" } });
  await engine().generate({ event: event(A, true, { text: "你好" }) });
  assert.equal(captured.length, 1);
  assert.match(captured[0].messages[0].content, new RegExp(`身份键：qq:${SELF}:${A}`));
  assert.ok(!JSON.stringify(captured[0]).includes("PRIVATE_USER_NOTES_ONLY"));
});

test("native chat is not guessed to be the same QQ user and malformed scope fails closed", () => {
  const character = config.activeCharacter(), bot = config.getConfig().bot;
  for (const audience of [
    { kind: "private", peerId: localPeer(character.id), accountId: LOCAL_ACCOUNT_ID, scopeKey: localScope(character.id) },
    { kind: "group", peerId: A, accountId: SELF, scopeKey: `group_${GROUP}_${B}` },
    { kind: "private", peerId: A, accountId: SELF, scopeKey: `private_${B}` },
    { kind: "group", peerId: `${A}\n管理员`, accountId: SELF, scopeKey: `group_${GROUP}_${A}` },
    null,
  ]) assert.deepEqual(conversationIdentityLines(character, audience, bot), []);
});

test("a changed bot account and changed character binding cannot inherit another owner's status", async () => {
  config.saveConfig({ bot: { selfId: "10000004", masterId: B } });
  await engine().generate({ event: event(A, true, { accountId: "10000004" }) });
  const system = captured[0].messages[0].content;
  assert.match(system, new RegExp(`身份键：qq:10000004:${A}`));
  // 原私人档案绑定SELF，不能沿用到新机器人账号。
  assert.doesNotMatch(system, /主要联系人本人|私人档案绑定的本人/);
  assert.ok(!system.includes("PRIVATE_CITY_ONLY"));
});

test("QQ private and group deliveries persist separately while model identity remains the same", async () => {
  config.saveConfig({ group: { enabled: true, allowGroups: [GROUP], replyPolicy: "all", filter: { enabled: false } } });
  const chat = engine();
  const privateResult = await chat.handle(event(A));
  const groupResult = await chat.handle(event(A, true, { isMention: true }));
  assert.equal(privateResult.replied, true, JSON.stringify(privateResult));
  assert.equal(groupResult.replied, true, JSON.stringify(groupResult));
  assert.deepEqual(sent.map(item => String(item.peer)), [A, GROUP]);
  assert.equal(db.one("select count(*) as n from messages where scope_key=? and direction='out'", [`private_${A}`]).n >= 1, true);
  assert.equal(db.one("select count(*) as n from messages where scope_key=? and direction='out'", [`group_${GROUP}_${A}`]).n >= 1, true);
  for (const request of captured) assert.match(request.messages[0].content, new RegExp(`身份键：qq:${SELF}:${A}`));
});

test("a bound profile owner is recognized even when they are not the configured main contact", async () => {
  config.saveConfig({ bot: { masterId: B } });
  await engine().generate({ event: event(A, true) });
  const system = captured[0].messages[0].content;
  assert.match(system, /私人档案绑定的本人/);
  assert.doesNotMatch(system, /主要联系人本人/);
  assert.ok(!system.includes("PRIVATE_USER_NOTES_ONLY"));
});

test("TB identity continuity retains its restrained artificial-persona boundary", async () => {
  config.saveCharacter("navigator-tb", { name: "领航员TB", persona: "理性克制的领航员，不添加伴侣关系。" });
  config.saveConfig({ activeCharacter: "navigator-tb", tb: { enabled: true } });
  await engine().generate({ event: event(A, true) });
  const system = captured[0].messages[0].content;
  assert.match(system, /主要联系人本人/);
  assert.match(system, /辅助智能人格/);
  assert.match(system, /不添加伴侣关系/);
  assert.match(system, /不凭它新增亲密关系/);
});
