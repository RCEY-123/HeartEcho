import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const appRoot = process.env.HEARTECHO_TEST_APP_ROOT || root;
const appImport = file => import(pathToFileURL(path.join(appRoot, "lib", file)).href);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "heartecho-cards-"));
for (const key of Object.keys(process.env)) if (key.startsWith("HEARTECHO_")) delete process.env[key];
Object.assign(process.env, { HEARTECHO_APP_DIR: tmp, HEARTECHO_DATA_DIR: path.join(tmp, "data"), HEARTECHO_LOG_DIR: path.join(tmp, "logs"), HEARTECHO_LOG_LEVEL: "error" });
(await appImport("paths.mjs")).ensureDirs();
const db = await appImport("db.mjs"); db.getDb();
const config = await appImport("config.mjs");
const cards = await appImport("character-cards.mjs");
const lifecycle = await appImport("scope-lifecycle.mjs");
const { insertMessage } = await appImport("storage.mjs");
const { addMemory } = await appImport("memory.mjs");
const { localScope, LOCAL_ACCOUNT_ID } = await appImport("local-channel.mjs");
const { createApiServer } = await appImport("api.mjs");
const { panelToken } = await appImport("panel-auth.mjs");
const { ChatEngine } = await appImport("chat.mjs");
const { LlmGateway } = await appImport("llm.mjs");
const { Scheduler } = await appImport("scheduler.mjs");
const sent = [];
const client = { selfId: "10000001", sendPrivateMsg: async (peer, text) => { sent.push({ peer, text }); return { message_id: 123 }; }, sendGroupMsg: async () => ({ message_id: 124 }) };
const chat = new ChatEngine({ client, llm: new LlmGateway() });
const server = createApiServer({ client, chat, llm: chat.llm, log: { info() {}, warn() {}, error() {} }, control: {} });
await server.listen(0, "127.0.0.1");
const base = "http://127.0.0.1:" + server.server.address().port;
const nativeFetch = globalThis.fetch;
async function request(route, body, method = body ? "POST" : "GET") {
  const response = await nativeFetch(base + route, { method, headers: { Authorization: "Bearer " + panelToken(), "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { response, body: await response.json() };
}
const fixture = id => ({ id, name: "合成角色 " + id, persona: "合成基础人设", speechStyle: "自然说话" });
const create = id => config.saveCharacter(id, fixture(id), { create: true });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
config.saveCharacter("keeper", fixture("keeper"), { create: true });
config.saveConfig({ activeCharacter: "keeper", bot: { selfId: "10000001", masterId: "10000002" }, life: { enabled: false }, nextMemory: { enabled: false }, weather: { enabled: false }, chat: { firstDelayMs: 0, splitBubbles: false, antiStall: false, rememberFacts: false, privateMergeWindowSec: 0, quietHours: { enabled: false }, followUp: { enabled: false } }, llm: { profiles: { default: { baseUrl: "https://cards.invalid/v1", apiKey: "SYNTHETIC_ONLY", model: "fixture" } } } });
after(() => {
  globalThis.fetch = nativeFetch; chat.stop(); server.close(); db.closeDb();
  assert.equal(path.dirname(tmp), os.tmpdir()); assert.ok(path.basename(tmp).startsWith("heartecho-cards-"));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("last card and missing confirmation are rejected without changing card or active role", async () => {
  let result = await request("/api/characters/keeper", { mode: "all", confirmation: "keeper" }, "DELETE");
  assert.equal(result.body.ok, false); assert.match(result.body.message, /至少/);
  result = await request("/api/characters/keeper", { mode: "keep" }, "DELETE");
  assert.equal(result.body.ok, false); assert.equal(config.loadCharacter("keeper").name, fixture("keeper").name);
  assert.equal(config.activeCharacterId(), "keeper");
});

test("all 22 repository cards import by API, duplicate IDs skip, exported long fields and metadata round trip", async () => {
  const dir = path.join(root, "角色卡", "碧蓝航线");
  const files = fs.readdirSync(dir, { withFileTypes: true }).filter(item => item.isDirectory()).flatMap(item => fs.readdirSync(path.join(dir, item.name)).filter(name => name.endsWith(".json")).map(name => ({ name, content: fs.readFileSync(path.join(dir, item.name, name), "utf8") })));
  assert.equal(files.length, 22);
  const result = await request("/api/characters/import", { files });
  assert.equal(result.body.imported, 22); assert.equal(config.activeCharacterId(), "keeper");
  const repeated = await request("/api/characters/import", { files });
  assert.equal(repeated.body.imported, 0); assert.ok(repeated.body.results.every(row => row.status === "skipped"));
  const source = JSON.parse(files[0].content);
  config.saveCharacter(source.id, { user: { notes: "PRIVATE_SENTINEL" }, userOwnerId: "10000002", userAccountId: "10000001", localUserEnabled: true, unrelatedSecret: "PRIVATE_SECRET", avatar: "C:\\private\\avatar.png" });
  const exported = await request("/api/characters/" + encodeURIComponent(source.id) + "/export");
  assert.match(exported.response.headers.get("content-disposition"), /attachment/);
  for (const field of ["persona", "appearance", "personality", "speechStyle", "habits", "relations", "exampleDialogue", "greeting", "extras", "cardMetadata"]) assert.deepEqual(exported.body[field], source[field]);
  assert.doesNotMatch(JSON.stringify(exported.body), /PRIVATE_|1000000|C:\\\\/); assert.equal(exported.body.localUserEnabled, false);
  const roundtrip = { ...exported.body, id: "roundtrip" };
  assert.equal((await request("/api/characters/import", { files: [{ name: "roundtrip.json", content: JSON.stringify(roundtrip) }] })).body.imported, 1);
  assert.equal(config.loadCharacter("roundtrip").exampleDialogue, source.exampleDialogue);
});

test("malformed/index/traversal/reserved-name cards fail per file while a valid sibling imports", async () => {
  const inputs = ["<html>not raw JSON</html>", "[]", JSON.stringify({ cards: [] }), JSON.stringify({ ...fixture("../escape") }), JSON.stringify({ ...fixture("CON") }), JSON.stringify({ ...fixture("invalid-field"), persona: {} }), JSON.stringify(fixture("good-sibling"))];
  const result = await request("/api/characters/import", { files: inputs.map((content, i) => ({ name: i + ".json", content })) });
  assert.equal(result.body.imported, 1); assert.equal(result.body.results.filter(row => row.status === "error").length, 6);
  assert.throws(() => cards.importCharacterCards(Array(51).fill({})), /50/);
});

test("keep-data removal changes active role; same-ID reimport and database restart recover the original records", async () => {
  create("keep-data"); config.saveConfig({ activeCharacter: "keep-data" });
  const scope = localScope("keep-data");
  insertMessage({ eventKey: "keep-message", scopeKey: scope, direction: "in", body: "合成历史", characterId: "keep-data", accountId: LOCAL_ACCOUNT_ID });
  const memory = addMemory({ scopeKey: scope, characterId: "keep-data", content: "合成记忆", sourceType: "authored" });
  const result = await request("/api/characters/keep-data", { mode: "keep", confirmation: "keep-data" }, "DELETE");
  assert.equal(result.body.ok, true); assert.notEqual(result.body.active, "keep-data");
  assert.ok(db.one("select id from messages where event_key='keep-message'")); assert.ok(db.one("select id from memories where id=?", [memory.id]));
  assert.equal((await request("/api/characters/import", { files: [{ name: "card.json", content: JSON.stringify(fixture("keep-data")) }] })).body.imported, 1);
  db.closeDb(); db.getDb();
  assert.equal(chat.local.history("keep-data").messages[0].body, "合成历史"); assert.ok(db.one("select id from memories where id=?", [memory.id]));
});

test("all-data deletion removes only owned data, queues remote erasure and prevents memory resurrection after reimport", async () => {
  create("remove-data"); create("other-data");
  const scope = "private_10000002";
  for (const id of ["remove-data", "other-data"]) {
    insertMessage({ eventKey: id + "-message", scopeKey: scope, direction: "in", body: id, characterId: id, accountId: "10000001" });
    addMemory({ scopeKey: scope, characterId: id, content: id + "记忆", sourceType: "authored" });
    db.run("insert into body_profiles values(?,?,?)", [id, "{}", Date.now()]);
    db.run("insert into body_days values(?,?,?)", [id, "2026-11-13", "{}"]);
    db.run("insert into character_evolution values(?,1,?,'[]',1,1)", [id, "{}"]);
    db.run("insert into hindsight_records values(?,?,?,?,?,?,?,?,?,?,?,1,0,?)", [id, id, "10000001", scope, 0, "2026-11-13", id + "摘要", id + "-bank", "revision", "https://memory.invalid", "consent", Date.now()]);
    db.run("insert into meta values(?,?)", ["daily-source:" + id, JSON.stringify({ experiences: [{ text: id + "亲身经历" }] })]);
  }
  const otherEpoch = lifecycle.characterGeneration("other-data"), scopeEpoch = lifecycle.scopeGeneration(scope);
  const result = await request("/api/characters/remove-data", { mode: "all", confirmation: "remove-data" }, "DELETE");
  assert.equal(result.body.ok, true, result.body.message); assert.equal(result.body.remoteErasurePending, true);
  assert.equal(db.one("select id from messages where event_key='remove-data-message'"), null);
  assert.ok(db.one("select id from messages where event_key='other-data-message'"));
  for (const table of ["memories", "body_profiles", "body_days", "character_evolution", "hindsight_records", "conversation_evaluations", "conversation_facts"]) assert.equal(db.one(`select count(*) as n from ${table} where character_id='remove-data'`).n, 0);
  assert.ok(db.one("select bank_id from hindsight_deletions where bank_id='remove-data-bank'"));
  assert.equal(db.one("select value from meta where key='daily-source:remove-data'"), null);
  assert.ok(db.one("select value from meta where key='daily-source:other-data'"));
  assert.equal(db.one("select count(*) as n from memories where character_id='other-data'").n, 1);
  assert.equal(lifecycle.characterGeneration("other-data"), otherEpoch); assert.equal(lifecycle.scopeGeneration(scope), scopeEpoch);
  cards.importCharacterCards([{ name: "again.json", content: JSON.stringify(fixture("remove-data")) }]); db.closeDb(); db.getDb();
  assert.equal(db.one("select count(*) as n from memories where character_id='remove-data'").n, 0);
});

test("deletion during a real model request prevents the old reply and usage write-back even after same-ID reimport", async () => {
  create("in-flight"); config.saveConfig({ activeCharacter: "in-flight" });
  const started = deferred(), release = deferred(); sent.length = 0;
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith(base)) return nativeFetch(url, opts);
    assert.equal(new URL(url).hostname, "cards.invalid"); started.resolve(); await release.promise;
    return new Response(JSON.stringify({ choices: [{ message: { content: "过期的回复" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } }));
  };
  const work = chat.handle({ kind: "private", scopeKey: "private_10000002", senderId: "10000002", accountId: "10000001", eventId: "in-flight-message", messageId: "flight", timestampMs: Date.now(), text: "你好", images: [], files: [], segments: [] });
  await started.promise;
  const result = await request("/api/characters/in-flight", { mode: "all", confirmation: "in-flight" }, "DELETE");
  assert.equal(result.body.ok, true, result.body.message);
  cards.importCharacterCards([{ name: "again.json", content: JSON.stringify(fixture("in-flight")) }]); config.saveConfig({ activeCharacter: "in-flight" });
  release.resolve(); await work; globalThis.fetch = nativeFetch;
  assert.equal(sent.length, 0); assert.equal(db.one("select count(*) as n from messages m join message_origins o on o.event_key=m.event_key where o.character_id='in-flight'").n, 0);
  assert.equal(db.one("select count(*) as n from llm_usage where character_id='in-flight'").n, 0);
});

test("deletion waits for an already handed-off send and blocks same-ID writes until completion", async () => {
  create("draining"); const started = deferred(), release = deferred();
  const sending = lifecycle.trackScopeSend(["character:draining"], async () => { started.resolve(); await release.promise; });
  await started.promise;
  const deletion = cards.removeCharacterCard("draining", { mode: "keep", confirmation: "draining" });
  await new Promise(resolve => setImmediate(resolve));
  assert.throws(() => config.saveCharacter("draining", fixture("draining")), /正在删除/);
  assert.throws(() => config.cloneCharacter("draining"), /正在删除/);
  assert.equal(cards.importCharacterCards([{ name: "again.json", content: JSON.stringify(fixture("draining")) }]).results[0].status, "error");
  assert.ok(fs.existsSync(config.characterPath("draining")));
  release.resolve(); await sending; await deletion;
  assert.equal(fs.existsSync(config.characterPath("draining")), false);
});

test("a composed proactive reply retains its role identity across deletion and cannot be delivered as the next role", async () => {
  for (const local of [false, true]) {
    const id = local ? "compose-local" : "compose-qq"; create(id); config.saveConfig({ activeCharacter: id });
    const scheduler = new Scheduler({ client, llm: { speak: async () => ({ text: "过期主动消息", requestId: "synthetic", usage: {} }) } });
    const peerId = local ? localScope(id).slice(8) : "10000002";
    const composed = await scheduler.compose({ occasion: "合成提醒", peerId });
    const before = sent.length;
    await cards.removeCharacterCard(id, { mode: "all", confirmation: id });
    const result = await scheduler.deliver({ peerId, ...composed, kind: "test", idempotencyKey: id });
    assert.equal(result, null); assert.equal(sent.length, before);
    assert.equal(db.one("select id from outgoing where idempotency_key=?", [id]), null);
  }
});

test("a database cleanup failure preserves the card and its records for retry", async () => {
  create("retry-delete"); config.saveConfig({ activeCharacter: "retry-delete" });
  const memory = addMemory({ scopeKey: localScope("retry-delete"), characterId: "retry-delete", content: "不能误删", sourceType: "authored" });
  db.run("create trigger fixture_delete_failure before delete on memories when old.character_id='retry-delete' begin select raise(abort,'synthetic cleanup failure'); end");
  await assert.rejects(cards.removeCharacterCard("retry-delete", { mode: "all", confirmation: "retry-delete" }), /synthetic/);
  assert.equal(config.activeCharacterId(), "retry-delete"); assert.equal(config.loadCharacter("retry-delete").id, "retry-delete");
  assert.ok(db.one("select id from memories where id=?", [memory.id]));
  db.run("drop trigger fixture_delete_failure");
  await cards.removeCharacterCard("retry-delete", { mode: "all", confirmation: "retry-delete" });
  assert.equal(db.one("select id from memories where id=?", [memory.id]), null);
});
