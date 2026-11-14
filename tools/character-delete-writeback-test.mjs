// Consumer-boundary regression: the model has already returned before deletion.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const appRoot = process.env.HEARTECHO_TEST_APP_ROOT || path.resolve(import.meta.dirname, "..");
const appImport = file => import(pathToFileURL(path.join(appRoot, "lib", file)).href);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "heartecho-delete-writeback-"));
for (const key of Object.keys(process.env)) if (key.startsWith("HEARTECHO_")) delete process.env[key];
Object.assign(process.env, { HEARTECHO_APP_DIR: tmp, HEARTECHO_DATA_DIR: path.join(tmp, "data"), HEARTECHO_LOG_DIR: path.join(tmp, "logs"), HEARTECHO_LOG_LEVEL: "error" });
(await appImport("paths.mjs")).ensureDirs();
const db = await appImport("db.mjs"); db.getDb();
const config = await appImport("config.mjs");
const cards = await appImport("character-cards.mjs");
const storage = await appImport("storage.mjs");
const life = await appImport("life.mjs");
const memory = await appImport("extended-memory.mjs");
const { addMemory } = await appImport("memory.mjs");
const { LlmGateway } = await appImport("llm.mjs");
const { scopeGeneration } = await appImport("scope-lifecycle.mjs");
const nativeFetch = globalThis.fetch;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const fixture = id => ({ id, name: "合成角色", persona: "合成角色人设" });
config.saveCharacter("keeper", fixture("keeper"), { create: true });
config.saveConfig({ activeCharacter: "keeper", bot: { selfId: 100, masterId: 200 }, life: { enabled: true }, weather: { enabled: false }, nextMemory: { enabled: false }, llm: { profiles: { default: { provider: "custom", baseUrl: "https://writeback.invalid/v1", apiKey: "SYNTHETIC_ONLY", model: "fixture" } } } });
after(() => {
  globalThis.fetch = nativeFetch; db.closeDb();
  assert.equal(path.dirname(tmp), os.tmpdir()); assert.ok(path.basename(tmp).startsWith("heartecho-delete-writeback-"));
  fs.rmSync(tmp, { recursive: true, force: true });
});

for (const kind of ["diary", "reflection"]) for (const mode of ["keep", "all"]) test(`${kind} consumer rejects completed old output after ${mode} deletion and same-ID reimport`, { timeout: 10000 }, async () => {
  const id = kind + "-" + mode;
  const character = config.saveCharacter(id, fixture(id), { create: true });
  const scope = "private_" + ({ "diary-keep": 210, "diary-all": 211, "reflection-keep": 212, "reflection-all": 213 }[id]);
  config.saveConfig({ nextMemory: { enabled: false }, life: { enabled: true, diary: { enabled: true }, reflection: { enabled: true, minEvidence: 3 } } });
  for (let n = 0; n < 3; n++) {
    const at = Date.now();
    const source = storage.insertMessage({ eventKey: id + n, scopeKey: scope, characterId: id, accountId: "100", direction: "in", senderId: scope.slice(8), at, body: `${id} 合成经历 ${n}` });
    addMemory({ scopeKey: scope, characterId: id, accountId: "100", content: `${id} 我记得聊天的合成经历 ${n}。`, category: "episodic", sourceType: "observed", at, sourceMessageId: source.messageId });
  }
  globalThis.fetch = async url => {
    assert.equal(new URL(url).hostname, "writeback.invalid");
    const content = kind === "diary" ? "今天我记下相处中值得珍惜的片刻。" : JSON.stringify({ reflections: [{ text: "我希望认真记住这些相处的片刻。", confidence: .8, evidence: [1, 2, 3] }] });
    return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } }));
  };
  const completedModel = deferred(), releaseConsumer = deferred();
  const gateway = new LlmGateway();
  const method = kind === "diary" ? "chat" : "json";
  const llm = { [method]: async (...args) => {
    const result = await gateway[method](...args);
    completedModel.resolve(); await releaseConsumer.promise; return result;
  } };
  const work = kind === "diary" ? life.writeDiary({ llm, character, scopeKey: scope, force: true }) : life.reflect({ llm, character, scopeKey: scope, accountId: "100" });
  const outcome = work.then(value => ({ value }), error => ({ error }));
  await completedModel.promise;
  try {
    await cards.removeCharacterCard(id, { mode, confirmation: id });
    assert.equal(cards.importCharacterCards([{ name: id + ".json", content: JSON.stringify(fixture(id)) }]).imported, 1);
  } finally { releaseConsumer.resolve(); }
  await outcome;
  assert.equal(db.one("select count(*) as n from memories where character_id=? and category=?", [id, kind]).n, 0);
  assert.equal(db.one("select count(*) as n from reflections where character_id=?", [id]).n, 0);
});

for (const kind of ["legacy", "extended"]) test(`${kind} archive cannot write back after completed model return, role deletion and same-ID reimport`, { timeout: 10000 }, async () => {
  const id = "removed-" + kind;
  const character = config.saveCharacter(id, fixture(id), { create: true });
  const scope = kind === "legacy" ? "private_200" : "private_201";
  const at = Date.now();
  storage.insertMessage({ eventKey: id, scopeKey: scope, characterId: id, accountId: "100", direction: "in", senderId: scope.slice(8), at, body: "我想与你一起去看海" });
  storage.insertMessage({ eventKey: id + "-other", scopeKey: scope, characterId: "keeper", accountId: "100", direction: "in", senderId: scope.slice(8), at, body: "另一个角色的合成记录" });
  config.saveConfig({ nextMemory: { enabled: kind === "extended", mode: "local" } });
  if (kind === "extended") config.saveConfig({ nextMemory: { consentDigest: memory.memoryDisclosure().fingerprint } });
  globalThis.fetch = async url => {
    assert.equal(new URL(url).hostname, "writeback.invalid");
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: "她记住了看海的约定。", experiences: [{ text: "我记得与你一起看海的约定。", importance: .8 }], facts: [] }) }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } }));
  };
  const completedModel = deferred(), releaseConsumer = deferred();
  const gateway = new LlmGateway();
  const actualJson = gateway.json.bind(gateway);
  const llm = { json: async (messages, options) => {
    const result = await actualJson(messages, options);
    if (options.characterId === id) { completedModel.resolve(); await releaseConsumer.promise; }
    return result;
  } };
  const generation = scopeGeneration(scope);
  const work = kind === "legacy"
    ? life.archiveScope({ llm, character, scopeKey: scope, accountId: "100" })
    : memory.archiveExtendedDaily(llm, new Date(), { force: true });
  const outcome = work.then(value => ({ value }), error => ({ error }));
  await completedModel.promise;
  try {
    await cards.removeCharacterCard(id, { mode: "all", confirmation: id });
    assert.equal(cards.importCharacterCards([{ name: id + ".json", content: JSON.stringify(fixture(id)) }]).imported, 1);
  } finally { releaseConsumer.resolve(); }
  await outcome;
  assert.equal(scopeGeneration(scope), generation, "another character shares this QQ conversation");
  assert.ok(db.one("select id from messages where event_key=?", [id + "-other"]));
  assert.equal(db.one("select count(*) as n from memories where character_id=?", [id]).n, 0, "deleted role memories must not be restored by an old consumer");
  assert.equal(db.one("select count(*) as n from hindsight_records where character_id=?", [id]).n, 0, "deleted role summaries must not be restored by an old consumer");
});
