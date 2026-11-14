import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "he-life-continuity-"));
for (const key of Object.keys(process.env))
  if (key.startsWith("HEARTECHO_") && !key.startsWith("HEARTECHO_TEST_")) delete process.env[key];
Object.assign(process.env, {
  HEARTECHO_APP_DIR: tmp,
  HEARTECHO_DATA_DIR: path.join(tmp, "data"),
  HEARTECHO_LOG_DIR: path.join(tmp, "logs"),
  HEARTECHO_LOG_LEVEL: "error",
});
const root = process.env.HEARTECHO_TEST_APP_ROOT || path.resolve(import.meta.dirname, "..");
const url = (name) => pathToFileURL(path.join(root, "lib", name + ".mjs")).href;
const mod = (name) => import(url(name));
const paths = await mod("paths");
paths.ensureDirs();
const db = await mod("db"),
  config = await mod("config"),
  storage = await mod("storage"),
  cognition = await mod("cognition");
const memory = await mod("extended-memory"),
  life = await mod("life"),
  body = await mod("body-state"),
  evolution = await mod("character-evolution");
const { continuityPrompt } = await mod("continuity-context"),
  { runContinuity } = await mod("continuity-runtime"),
  { cleanReply } = await mod("util");
const scheduler = await mod("scheduler"),
  { localScope, LOCAL_ACCOUNT_ID } = await mod("local-channel");
db.getDb();
let seq = 0;
const char = "continuity-fixture",
  scope = "private_200";
const tables = [
  "reflection_owners",
  "forgotten_fact_sources",
  "messages",
  "message_origins",
  "sessions",
  "conversation_evaluations",
  "conversation_facts",
  "memories",
  "memory_tokens",
  "hindsight_records",
  "reflections",
  "meta",
  "scope_resets",
  "role_scope_resets",
  "character_evolution",
  "evolution_history",
  "body_profiles",
  "body_days",
  "anniversaries",
  "birthday_owners",
];
beforeEach(() => {
  for (const table of tables) db.run("delete from " + table);
  config.saveCharacter(char, { name: "合成角色", persona: "安静的图书管理员", locked: [] });
  config.saveConfig({
    activeCharacter: char,
    bot: { selfId: 100, masterId: 200 },
    life: { enabled: true, reflection: { enabled: true, minEvidence: 3, everyHours: 24 } },
    nextMemory: { enabled: true, mode: "local" },
  });
  config.saveConfig({ nextMemory: { consentDigest: memory.memoryDisclosure().fingerprint } });
});
after(() => {
  db.closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});
function put(text, patch = {}) {
  return storage.insertMessage({
    eventKey: "synthetic-" + ++seq,
    scopeKey: scope,
    characterId: char,
    accountId: "100",
    direction: "in",
    senderId: "200",
    body: text,
    ...patch,
  });
}
const audience = { kind: "private", accountId: "100", peerId: "200", scopeKey: scope };
const allowed = () => memory.memoryConsentValid() && config.getConfig().nextMemory.enabled;
const enrich = (llm) =>
  cognition.enrichConversations(llm, { allowed, fingerprint: () => memory.memoryDisclosure().fingerprint });

test("every original input/output evaluated once; birthday instantly recalled and corrected only in own scope", () => {
  const first = put("我的生日是3月15号");
  storage.insertMessage({
    eventKey: "synthetic-" + seq,
    scopeKey: scope,
    direction: "in",
    body: "duplicate",
    characterId: char,
    accountId: "100",
  });
  put("记住啦", { direction: "out" });
  assert.equal(cognition.cognitionSnapshot(char).stats.evaluated, 2);
  assert.equal(cognition.conversationFacts(char, "100", scope)[0].message_id, first.messageId);
  assert.match(continuityPrompt(config.loadCharacter(char), audience), /03-15/);
  put("我的生日是4月16号");
  const text = continuityPrompt(config.loadCharacter(char), audience);
  assert.match(text, /04-16/);
  assert.doesNotMatch(text, /03-15/);
  for (const other of [
    { ...audience, accountId: "999" },
    { ...audience, scopeKey: "private_201" },
    { kind: "group", accountId: "100", peerId: "200", scopeKey: "group_300_200" },
  ])
    assert.doesNotMatch(continuityPrompt(config.loadCharacter(char), other), /04-16/);
});
test("questions, impossible dates, quoted birthdays and late timestamps alone are not evidence", () => {
  for (const text of [
    "我的生日是2月31号",
    "我的生日是3月15号吗？",
    "他说“我的生日是3月15号”",
    "假如我的生日是3月15号",
    "现在凌晨三点",
  ])
    assert.equal(cognition.evaluateText(text).facts.length, 0, text);
  assert.equal(cognition.validMonthDay("02-29"), true);
});
test("schedule birthdays feed only their bound private conversation, with valid dates and deletion", () => {
  const b = scheduler.addBirthday({ peerId: "200", name: "对方", monthDay: "05-06" });
  assert.match(continuityPrompt(config.loadCharacter(char), audience), /05-06/);
  assert.doesNotMatch(
    continuityPrompt(config.loadCharacter(char), { ...audience, kind: "group", scopeKey: "group_300_200" }),
    /05-06/,
  );
  scheduler.deleteBirthday(b.id);
  assert.doesNotMatch(continuityPrompt(config.loadCharacter(char), audience), /05-06/);
  scheduler.addBirthday({ monthDay: "07-08", peerId: localScope(char).slice(8) });
  assert.match(
    continuityPrompt(config.loadCharacter(char), {
      kind: "private",
      accountId: LOCAL_ACCOUNT_ID,
      scopeKey: localScope(char),
    }),
    /07-08/,
  );
  assert.throws(() => scheduler.addBirthday({ monthDay: "13-33" }));
});
test("semantic extraction requires exact evidence; clear during model wait cannot restore facts or scores", async () => {
  put("我喜欢安静的书店");
  await enrich({
    json: async () => ({
      json: {
        importance: 0.9,
        confidence: 0.9,
        facts: [
          { category: "preference", quote: "我喜欢安静的书店" },
          { category: "fact", quote: "凭空杜撰的工作" },
        ],
      },
    }),
  });
  assert.equal(cognition.conversationFacts(char, "100", scope).length, 1);
  put("我明天想再去书店");
  await enrich({
    json: async () => {
      storage.clearMessages(scope, { characterId: char, accountId: "100" });
      return {
        json: { importance: 0.9, confidence: 0.9, facts: [{ category: "agreement", quote: "我明天想再去书店" }] },
      };
    },
  });
  assert.equal(cognition.cognitionSnapshot(char).stats.evaluated, 0);
  assert.equal(cognition.conversationFacts(char, "100", scope).length, 0);
});
test("revoking consent during evaluation prevents writeback and preserves pending work", async () => {
  put("我喜欢安静的书店");
  await enrich({
    json: async () => {
      config.saveConfig({ nextMemory: { consentDigest: "" } });
      return {
        json: { importance: 0.9, confidence: 0.9, facts: [{ category: "preference", quote: "我喜欢安静的书店" }] },
      };
    },
  });
  assert.equal(cognition.conversationFacts(char, "100", scope).length, 0);
  assert.equal(cognition.cognitionSnapshot(char).stats.pending, 1);
});
test("archive failure in one conversation does not starve another or advance the failed cursor", async () => {
  put("SYNTHETIC_FAIL");
  put("SYNTHETIC_OK", { scopeKey: "private_201" });
  const result = await memory.archiveExtendedDaily(
    {
      json: async (m) => {
        if (m[1].content.includes("SYNTHETIC_FAIL")) throw new Error("synthetic");
        return { json: { summary: "独立成功摘要", experiences: [] } };
      },
    },
    new Date(),
    { force: true },
  );
  assert.equal(result.failed, 1);
  assert.equal(result.archived, 1);
  assert.equal(db.one("select count(*) as n from hindsight_records").n, 1);
  assert.equal(db.one("select scope_key from hindsight_records").scope_key, "private_201");
});
test("routine observations create evidence-backed reflection; diary consumes it in new memory mode", async () => {
  for (const text of ["我昨晚熬夜了", "我最近失眠了", "我这几天作息不规律"]) put(text);
  const result = await life.reflect({
    character: config.loadCharacter(char),
    scopeKey: scope,
    llm: {
      json: async () => ({
        json: {
          reflections: [{ text: "我注意到你最近提到休息不好，想适度关心。", confidence: 0.85, evidence: [1, 2, 3] }],
        },
      }),
    },
  });
  assert.equal(result.created.length, 1);
  let diaryInput = "";
  await life.writeDiary({
    character: config.loadCharacter(char),
    scopeKey: scope,
    llm: {
      chat: async (m) => {
        diaryInput = m.map((x) => x.content).join("\n");
        return { text: "我想起这几次聊天里提到的休息，心里多了一份惦记。" };
      },
    },
    force: true,
  });
  assert.match(diaryInput, /最近的自我反思/);
  assert.equal(db.one("select count(*) as n from memories where category='diary'").n, 1);
});
test("scheduler persists reflection due time and does not repeat it on next tick", async () => {
  for (const text of ["我昨晚熬夜了", "我最近失眠了", "我这几天作息不规律"]) put(text);
  let reflected = 0;
  const llm = {
    json: async (m) => {
      if (m[0].content.includes("做自我反思")) {
        reflected++;
        return {
          json: { reflections: [{ text: "我想更温和地关心你的休息。", confidence: 0.85, evidence: [1, 2, 3] }] },
        };
      }
      if (m[0].content.includes("逐条评估")) return { json: { importance: 0.8, confidence: 0.9, facts: [] } };
      return { json: { summary: "对方提到休息状况", experiences: [] } };
    },
  };
  await runContinuity(llm);
  await runContinuity(llm);
  assert.equal(reflected, 1);
});
test("consent and saved memory survive a fresh process, but changing service requires consent again", () => {
  put("我的生日是3月15号");
  const code = `const m=await import(${JSON.stringify(url("extended-memory"))});const c=await import(${JSON.stringify(url("cognition"))});if(!m.memoryConsentValid()||c.conversationFacts('${char}','100','${scope}').length!==1)process.exit(9);`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(child.status, 0, child.stderr);
  config.saveConfig({ llm: { profiles: { default: { model: "changed-model" } } } });
  assert.equal(memory.memoryConsentValid(), false);
});
test("body is opt-in, irreversibly initialized, isolated and stable across restart/month/year/clock rollback", () => {
  assert.equal(body.bodySnapshot(char).enabled, false);
  const now = new Date(2026, 10, 12, 12);
  assert.throws(() => body.enableBody(config.loadCharacter(char), {}, now), /确认/);
  body.enableBody(
    config.loadCharacter(char),
    {
      confirmIrreversible: true,
      cycleEnabled: true,
      cycleStart: "2026-11-01",
      constitution: 60,
      conditions: "呼吸系统先天较弱",
    },
    now,
  );
  const first = body.bodySnapshot(char, "2026-11", now);
  assert.equal(first.days.length, 30);
  assert.equal(first.days[0].recorded, false);
  body.advanceBody(char, new Date(2027, 0, 4, 12));
  const again = body.bodySnapshot(char, "2026-11", now);
  assert.deepEqual(again.today, first.today);
  assert.equal(body.bodySnapshot("other").enabled, false);
  assert.throws(() => body.enableBody(config.loadCharacter(char), { confirmIrreversible: true }, now), /不能/);
  db.closeDb();
  db.getDb();
  assert.deepEqual(body.bodySnapshot(char, "2026-11", now).today, first.today);
  assert.equal(body.bodySnapshot(char, "2027-02", new Date(2027, 0, 4)).days.length, 28);
});
test("nonbiological cycle can remain not applicable; sickness probabilities bounded and deterministic", () => {
  const state = body.enableBody(config.loadCharacter(char), {
    confirmIrreversible: true,
    cycleEnabled: false,
    constitution: 1,
  });
  assert.equal(state.today.phase, "不适用");
  assert.ok(state.risks.every((x) => x.dailyProbability > 0 && x.dailyProbability <= 0.025));
  assert.deepEqual(body.bodySnapshot(char).today, state.today);
  assert.throws(() => body.bodySnapshot(char, "2026-13"));
});

test("cycle stages follow the next period, with overlapping menstrual/ovarian phases and an uncertain ovulation window", () => {
  const p = {
    cycleEnabled: true,
    cycleStart: "2026-11-01",
    cycleLength: 28,
    periodDays: 5,
    variation: 0,
    seed: "fixture",
  };
  const at = (day, profile = p) => body.cycleAt(profile, day);
  assert.equal(at("2026-11-01").ovarianPhase, "卵泡期");
  assert.equal(at("2026-11-05").phase, "经期");
  assert.equal(at("2026-11-06").phase, "卵泡期");
  assert.equal(at("2026-11-15").phase, "排卵期（预计）");
  assert.equal(at("2026-11-16").phase, "黄体期");
  assert.equal(at("2026-11-28").subphase, "黄体晚期（经前）");
  assert.equal(at("2026-11-29").cycleDay, 1);
  assert.deepEqual(at("2026-11-15").ovulation, {
    estimatedDay: "2026-11-15",
    earliest: "2026-11-13",
    latest: "2026-11-19",
  });
  assert.equal(at("2026-11-19").inOvulationWindow, true);
  assert.equal(at("2026-11-20").inOvulationWindow, false);
  assert.equal(at("2026-11-22", { ...p, cycleLength: 35 }).phase, "排卵期（预计）");
  assert.equal(at("2026-11-15", { ...p, cycleLength: 35 }).phase, "卵泡期");
  assert.equal(at("2028-02-29", { ...p, cycleStart: "2028-02-15" }).phase, "排卵期（预计）");
  const atypical = at("2026-11-12", { ...p, cycleLength: 18, periodDays: 10 });
  assert.equal(atypical.phase, "阶段不确定");
  assert.equal(atypical.ovulation, null);
  assert.match(atypical.phaseDescription, /不足/);
});

test("legacy body rows gain estimated stages without rewriting the profile or historical events", () => {
  const now = new Date(2026, 10, 22, 12);
  body.enableBody(
    config.loadCharacter(char),
    { confirmIrreversible: true, cycleEnabled: true, cycleStart: "2026-11-01", variation: 0 },
    now,
  );
  const originalProfile = db.one("select profile_json from body_profiles where character_id=?", [char]).profile_json;
  const originalDay = JSON.stringify({
    phase: "非经期",
    cycleDay: 22,
    issues: [{ region: "头部", severity: "轻微不适", remainingDays: 2 }],
  });
  db.run("update body_days set state_json=? where character_id=?", [originalDay, char]);
  const state = body.bodySnapshot(char, "2026-11", now);
  assert.equal(state.today.phase, "黄体期");
  assert.equal(state.today.legacyPhase, "非经期");
  assert.equal(state.days[21].phase, state.today.phase);
  assert.equal(state.today.issues[0].remainingDays, 2);
  assert.match(body.bodyPrompt(char, now), /黄体期/);
  db.closeDb();
  db.getDb();
  assert.deepEqual(body.bodySnapshot(char, "2026-11", now).today, state.today);
  assert.equal(
    db.one("select profile_json from body_profiles where character_id=?", [char]).profile_json,
    originalProfile,
  );
  assert.equal(db.one("select state_json from body_days where character_id=?", [char]).state_json, originalDay);
});

test("detailed stages preserve the dev16 seeded cycle sequence and period boundaries", () => {
  const profile = { cycleEnabled: true, cycleStart: "2026-11-01", cycleLength: 28, periodDays: 5, variation: 5, seed: "fixture" };
  let start = Date.parse("2026-11-01T00:00:00Z");
  // Frozen dev.16 outputs, covering short/long cycles and a year boundary.
  for (const length of [32, 24, 31, 33, 29, 31, 28, 23, 25, 30, 27, 33]) {
    for (let offset = 0; offset < length; offset++) {
      const day = new Date(start + offset * 86400000).toISOString().slice(0, 10);
      const state = body.cycleAt(profile, day);
      assert.equal(state.cycleDay, offset + 1);
      assert.equal(state.cycleLength, length);
      assert.equal(state.phase === "经期", offset < 5);
    }
    start += length * 86400000;
  }
  assert.equal(body.cycleAt(profile, "2026-10-31").phase, "尚无记录");
  assert.equal(body.cycleAt({ ...profile, cycleEnabled: false }, "2026-11-15").phase, "不适用");
});

test("phase-aware chat and diary share the same simulated state without inventing symptoms", async () => {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 21, 12);
  const { dayKey } = await mod("util");
  body.enableBody(
    config.loadCharacter(char),
    { confirmIrreversible: true, cycleEnabled: true, cycleStart: dayKey(start), variation: 0 },
    now,
  );
  put("今天在家读书");
  await memory.archiveExtendedDaily(
    { json: async () => ({ json: { summary: "今天在家读书", experiences: [] } }) },
    now,
    { force: true },
  );
  let diaryInput = "";
  await life.writeDiary({
    character: config.loadCharacter(char),
    scopeKey: scope,
    force: true,
    llm: {
      chat: async (messages) => {
        diaryInput = messages.map((x) => x.content).join("\n");
        return { text: "今天安静地读了书。" };
      },
    },
  });
  for (const text of [continuityPrompt(config.loadCharacter(char), audience), diaryInput]) {
    assert.match(text, /黄体期/);
    assert.match(text, /日历估算/);
    assert.match(text, /不代表已经发生/);
  }
});
test("evolution preserves original card, refuses weak evidence and caps daily growth without leaking facts", () => {
  const original = config.loadCharacter(char);
  evolution.setEvolution(char, true);
  assert.equal(evolution.iterateCharacter(char, "100", scope).skipped, true);
  for (const text of ["我昨晚熬夜了", "我最近失眠了", "我这几天作息不规律"]) put(text);
  db.run(
    "insert into reflections(character_id,scope_key,source_type,content,evidence_count,confidence,source_memories_json,at,created_at) values(?,?,'inferred','有证据的反思',3,.9,'[]',?,?)",
    [char, scope, Date.now(), Date.now()],
  );
  const result = evolution.iterateCharacter(char, "100", scope);
  assert.equal(result.ok, true);
  assert.equal(evolution.iterateCharacter(char, "100", scope).skipped, true);
  assert.deepEqual(evolution.evolutionSnapshot(char).original, original);
  assert.deepEqual(config.loadCharacter(char), original);
  assert.equal(evolution.evolutionSnapshot(char).count, 1);
  assert.doesNotMatch(evolution.evolutionPrompt(char), /昨晚熬夜了|private_200/);
  evolution.setEvolution(char, false);
  assert.equal(evolution.evolutionPrompt(char), "");
});
test("reasoning markers removed before delivery; ordinary brackets and spoken prose preserved", () => {
  assert.equal(cleanReply("[_ pensiero: 12:06, greeting, Wuhan weather _]指挥官，中午好呀。"), "指挥官，中午好呀。");
  assert.equal(cleanReply("<think>秘密规划</think>记得带伞。"), "记得带伞。");
  assert.equal(cleanReply("<think>未完成分析"), "");
  assert.equal(cleanReply("这是[生日礼物]，我喜欢（蓝色）。"), "这是[生日礼物]，我喜欢（蓝色）。");
});
test("v4 upgrade creates continuity tables without changing original messages", () => {
  const row = put("保留的升级原文");
  db.getDb().exec(
    "drop table conversation_evaluations; drop table conversation_facts; drop table body_profiles; drop table body_days; drop table character_evolution; pragma user_version=4",
  );
  db.closeDb();
  db.getDb();
  assert.equal(db.one("select body from messages where id=?", [row.messageId]).body, "保留的升级原文");
  assert.equal(db.one("pragma user_version").user_version, 5);
  assert.equal(db.one("select count(*) as n from body_profiles").n, 0);
  assert.equal(db.one("select count(*) as n from conversation_evaluations").n, 0);
  assert.equal(db.integrityCheck().ok, true);
});

test("oversized original is fully archived in bounded pieces without prematurely advancing its cursor", async () => {
  const text = "甲".repeat(6100) + "中段标记" + "乙".repeat(6500) + "末尾标记";
  const row = put(text);
  const parts = [];
  const llm = {
    json: async (messages) => {
      parts.push(messages[1].content.split("对方: ")[1]);
      return { json: { summary: "按片段累计整理", experiences: [] } };
    },
  };
  await memory.archiveExtendedDaily(llm, new Date(), { force: true });
  const state = JSON.parse(db.one("select value from meta where key like 'daily-source:%'").value);
  assert.ok(state.upto < row.messageId);
  assert.ok(state.partialOffset > 0);
  for (let i = 0; i < 3; i++) await memory.archiveExtendedDaily(llm, new Date(), { force: true });
  assert.equal(parts.join(""), text);
  assert.equal(JSON.parse(db.one("select value from meta where key like 'daily-source:%'").value).upto, row.messageId);
});

test("forget during semantic evaluation cannot resurrect a source; clearing one role keeps another pending evaluation usable", async () => {
  const { continuityApi } = await mod("continuity-api");
  const original = put("我昨晚熬夜了");
  const fact = cognition.conversationFacts(char, "100", scope)[0];
  await enrich({
    json: async () => {
      await continuityApi(
        "POST /api/continuity/forget",
        new URL("http://localhost/api/continuity/forget"),
        { id: fact.id },
        { llm: {} },
      );
      return { json: { importance: 0.9, confidence: 0.9, facts: [{ category: "routine", quote: "我昨晚熬夜了" }] } };
    },
  });
  assert.equal(db.one("select count(*) as n from conversation_facts where message_id=?", [original.messageId]).n, 0);
  config.saveCharacter("other-role", { name: "合成第二角色" });
  put("我喜欢安静的书店", { characterId: "other-role" });
  storage.clearMessages(scope, { characterId: char, accountId: "100" });
  await enrich({
    json: async () => ({
      json: { importance: 0.9, confidence: 0.9, facts: [{ category: "preference", quote: "我喜欢安静的书店" }] },
    }),
  });
  assert.equal(cognition.conversationFacts("other-role", "100", scope).length, 1);
});

test("reflections from another bot account never enter the current diary", async () => {
  for (const text of ["我昨晚熬夜了", "我最近失眠了", "我这几天作息不规律"]) put(text);
  await life.reflect({
    character: config.loadCharacter(char),
    scopeKey: scope,
    llm: {
      json: async () => ({
        json: { reflections: [{ text: "我记得账户一的私人休息情况。", confidence: 0.9, evidence: [1, 2, 3] }] },
      }),
    },
  });
  config.saveConfig({ bot: { selfId: 101 } });
  let called = false;
  const result = await life.writeDiary({
    character: config.loadCharacter(char),
    scopeKey: scope,
    force: true,
    llm: {
      chat: async () => {
        called = true;
        return { text: "不应出现" };
      },
    },
  });
  assert.equal(called, false);
  assert.equal(result.skipped, true);
});

test("several summaries of one source message cannot count as independent reflection evidence", async () => {
  const source = put("我昨晚熬夜了");
  await memory.archiveExtendedDaily(
    {
      json: async () => ({
        json: {
          summary: "对方提到昨晚熬夜",
          experiences: [
            { text: "我听到你说昨晚熬夜，记住了这件事。", sourceMessageId: source.messageId },
            { text: "我想起你刚才说的昨晚熬夜。", sourceMessageId: source.messageId },
            { text: "我留意到你这一句关于熬夜的话。", sourceMessageId: source.messageId },
          ],
        },
      }),
    },
    new Date(),
    { force: true },
  );
  let called = false;
  const result = await life.reflect({
    character: config.loadCharacter(char),
    scopeKey: scope,
    llm: {
      json: async () => {
        called = true;
        return { json: { reflections: [] } };
      },
    },
  });
  assert.equal(called, false);
  assert.equal(result.skipped, true);
});

test("birthday remains available after hundreds of new facts; saving disabled evolution does not freeze an early original", () => {
  evolution.setEvolution(char, false);
  assert.equal(evolution.evolutionSnapshot(char).original, null);
  config.saveCharacter(char, { persona: "手工修改后的原始人设" });
  evolution.setEvolution(char, true);
  assert.equal(evolution.evolutionSnapshot(char).original.persona, "手工修改后的原始人设");
  const source = put("我的生日是3月15号");
  for (let n = 0; n < 240; n++)
    db.run(
      "insert into conversation_facts(message_id,character_id,account_id,scope_key,category,slot,content,confidence,importance,at) values(?,?,?,?,'fact','',?,.9,.8,?)",
      [source.messageId, char, "100", scope, "合成新事实" + n, Date.now() + n],
    );
  assert.match(continuityPrompt(config.loadCharacter(char), audience), /03-15/);
});
