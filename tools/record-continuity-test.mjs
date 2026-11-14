import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "heartecho-records-"));
for (const key of Object.keys(process.env)) if (key.startsWith("HEARTECHO_")) delete process.env[key];
Object.assign(process.env, {
  HEARTECHO_APP_DIR: tmp,
  HEARTECHO_DATA_DIR: path.join(tmp, "data"),
  HEARTECHO_LOG_DIR: path.join(tmp, "logs"),
  HEARTECHO_LOG_LEVEL: "error",
});
const { ensureDirs } = await import("../lib/paths.mjs");
ensureDirs();
const db = await import("../lib/db.mjs");
const config = await import("../lib/config.mjs");
const storage = await import("../lib/storage.mjs");
const memory = await import("../lib/extended-memory.mjs");
const life = await import("../lib/life.mjs");
const logs = await import("../lib/log.mjs");
db.getDb();
const character = config.saveCharacter("record-fixture", { name: "Fixture", persona: "Synthetic fixture" });
const today = new Date();
today.setHours(10, 0, 0, 0);
const yesterday = new Date(today);
yesterday.setDate(yesterday.getDate() - 1);
let seq = 0;
function put(at = today.getTime(), body = "SYNTHETIC_MESSAGE") {
  return storage.insertMessage({
    eventKey: `record-${++seq}`,
    scopeKey: "private_200",
    characterId: "record-fixture",
    accountId: "100",
    direction: "in",
    senderId: "200",
    at,
    body,
  });
}
function consent() {
  config.saveConfig({ nextMemory: { enabled: true, mode: "local" } });
  config.saveConfig({ nextMemory: { consentDigest: memory.memoryDisclosure().fingerprint } });
}
beforeEach(() => {
  config.saveCharacter(character.id, character);
  for (const table of [
    "messages",
    "message_origins",
    "sessions",
    "memories",
    "memory_tokens",
    "hindsight_records",
    "meta",
    "scope_resets",
  ])
    db.run(`delete from ${table}`);
  config.saveConfig({ bot: { selfId: 100 }, life: { enabled: true, simulated: { enabled: false } }, nextMemory: { enabled: false } });
});
after(() => {
  db.closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("log page history survives process restart and can read beyond 1200 entries", () => {
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const {createLogger}=await import(${JSON.stringify(new URL("../lib/log.mjs", import.meta.url).href)}); for(let n=0;n<1305;n++)createLogger('Fixture').info('restart-'+n+' 多字节测试'.repeat(10));`,
    ],
    { env: { ...process.env, HEARTECHO_LOG_LEVEL: "info" }, encoding: "utf8", windowsHide: true },
  );
  assert.equal(child.status, 0, child.stderr);
  const entries = logs.recentLogs(1500);
  assert.equal(entries.filter((e) => e.scope === "Fixture").length, 1305);
  assert.ok(entries.some((e) => e.message.startsWith("restart-0 ")));
  let page = logs.logHistory({ limit: 71 });
  const ids = [];
  while (true) {
    ids.push(...page.logs.map((row) => row.id));
    if (!page.hasMore) break;
    page = logs.logHistory({ limit: 71, before: page.before });
  }
  assert.equal(ids.length, new Set(ids).size, "page boundaries must not repeat same-second entries");
  assert.equal(ids.length, 1305);
});

test("conversation pagination includes all messages with equal timestamps and rejects other scopes' cursors", () => {
  for (let n = 0; n < 441; n++) put();
  const ids = [];
  let before = 0;
  while (true) {
    const page = storage.conversationPage("private_200", { before, limit: 53 });
    ids.push(...page.messages.map((row) => row.id));
    if (!page.hasMore) break;
    before = page.messages[0].id;
  }
  assert.equal(new Set(ids).size, 441);
  assert.equal(ids.length, 441);
  assert.throws(() => storage.conversationPage("private_201", { before: ids[0] }), /失效/);
});

test("legacy archiving acknowledges only the messages actually sent to the model", async () => {
  for (let n = 0; n < 240; n++) put(yesterday.getTime() + n, `part-${n}`);
  let input;
  const result = await life.archiveScope({
    character,
    scopeKey: "private_200",
    llm: {
      json: async (messages) => {
        input = messages[1].content;
        put(today.getTime(), "arrived-during-archive");
        return { json: { summary: "SYNTHETIC_SUMMARY", experiences: [] } };
      },
    },
  });
  assert.ok(input.includes("part-0"), "earliest pending messages must not be silently sliced away");
  assert.equal(storage.getSession("private_200").archived_upto, result.messages);
  assert.ok(storage.getSession("private_200").archived_upto < storage.messageCount("private_200"));
});

test("today's extended memory is visible in digital life without waiting until tomorrow", async () => {
  consent();
  put();
  put();
  const source = db.one("select * from messages order by id desc limit 1");
  await memory.archiveExtendedDaily({ json: async () => ({ json: { summary: "她记住了今天的相处。", experiences: [{ text: "我记得今天与你一起聊天的片刻。", sourceMessageId: source.id }] } }) });
  assert.equal(memory.listExtendedMemories().length, 1);
  const snapshot = life.lifeSnapshot({ characterId: "record-fixture" });
  assert.ok(snapshot.experienceDays.some((day) => day.items.some((row) => row.content.includes("我记得今天"))));
});

test("digital life uses the character's first-person moments, never the third-person daily report", async () => {
  consent();
  config.saveCharacter("record-fixture", { name: "Fixture", persona: "摩天轮上的约定", speechStyle: "害羞时嘴硬，称呼对方为你" });
  put(today.getTime(), "我们说好下次一起坐摩天轮");
  const source = db.one("select * from messages order by id desc limit 1");
  const summary = "她和对方约定下次一起坐摩天轮，提到约定时有些害羞。";
  const text = "我又想起和你坐摩天轮的约定，嘴上逞强，心里却偷偷期待起来。";
  let prompt;
  await memory.archiveExtendedDaily({ json: async (messages) => {
    prompt = messages.map(m => m.content).join("\n");
    return { json: { summary, experiences: [{ text, sourceMessageId: source.id }] } };
  } });
  const items = life.lifeSnapshot({ characterId: "record-fixture" }).experienceDays.flatMap(day => day.items);
  assert.ok(items.some(row => row.content === text), "timeline must show her own recollection");
  assert.ok(items.every(row => row.content !== summary && row.category !== "daily-summary"));
  assert.equal(items.find(row => row.content === text).at, source.at, "use the actual source time, never a synthetic noon timestamp");
  assert.equal(memory.listExtendedMemories()[0].content, summary, "memory remains an independent third-person record");
  assert.match(prompt, /摩天轮上的约定/);
  assert.match(prompt, /害羞时嘴硬/);
  assert.match(prompt, /第三人称/);
  assert.match(prompt, /第一人称/);
});

test("completed dev.8/dev.9 summaries are rebuilt from originals into personal moments without losing manual edits", async () => {
  consent();
  put(yesterday.getTime(), "你认真催我休息，发现才下午五点，又被我逗笑了");
  const digest = (await import("../lib/service-http.mjs")).digest;
  await memory.archiveExtendedDaily({ json: async () => ({ json: { summary: "今日主要为学习支持与情感陪伴。" } }) });
  const row = memory.listExtendedMemories()[0];
  const source = db.one("select * from messages order by id desc limit 1");
  db.run("insert or replace into meta values(?, ?)", [`daily-source:${row.id}`, JSON.stringify({ upto: source.id })]);
  const text = "我催你去睡觉，才发现还只是下午，被你逗得有些羞恼。";
  let calls = 0;
  await memory.archiveExtendedDaily({ json: async () => { calls++; return { json: { summary: "她关心对方的休息，因认错时间而有些害羞。", experiences: [{ text, sourceMessageId: source.id }] } }; } });
  assert.equal(calls, 1, "finished old source cursors must not prevent narrative repair");
  assert.ok(life.lifeSnapshot({ characterId: "record-fixture" }).experienceDays.flatMap(day => day.items).some(item => item.content === text));
  memory.editExtendedMemory(row.id, "用户亲自修正过的记忆，必须保留");
  assert.equal(life.lifeSnapshot({ characterId: "record-fixture" }).experienceDays.flatMap(day => day.items).some(item => item.content === text), false, "edited source immediately invalidates derived text");
  await memory.archiveExtendedDaily({ json: async () => ({ json: { summary: "不得覆盖手工修正", experiences: [{ text: "我记得你纠正过那件事，会认真记住。", sourceMessageId: source.id }] } }) });
  assert.equal(memory.listExtendedMemories()[0].content, "用户亲自修正过的记忆，必须保留");
  assert.notEqual(memory.listExtendedMemories()[0].revision, digest([row.id, "不得覆盖手工修正"]));
});

test("third-person reports and invented source IDs never become lived experiences", async () => {
  consent();
  put();
  const source = db.one("select * from messages order by id desc limit 1");
  await memory.archiveExtendedDaily({ json: async () => ({ json: {
    summary: "她陪对方聊了日常。",
    experiences: [
      { text: "今日主要为用户提供学习支持与情感陪伴。", sourceMessageId: source.id },
      { text: "我陪你坐了摩天轮。", sourceMessageId: source.id + 99999 },
    ],
  } }) });
  assert.equal(life.lifeSnapshot({ characterId: "record-fixture" }).experienceDays.length, 0);
  assert.equal(memory.listExtendedMemories().length, 1, "valid factual memory must not be discarded with an invalid narrative");
});

test("new personal moments feed first-person reflection and diary with editable-source fencing", async () => {
  consent();
  for (let n = 0; n < 3; n++) put(today.getTime() + n, `REAL_MOMENT_${n}`);
  const sources = db.all("select id from messages order by id");
  await memory.archiveExtendedDaily({ json: async () => ({ json: {
    summary: "她在交流中逐渐理解了对方的担心。",
    experiences: sources.map((s, n) => ({ text: `我记下了今天第${n + 1}次交流里的担心，想慢慢把这件事弄明白。`, sourceMessageId: s.id })),
  } }) });
  const result = await life.reflect({ character, scopeKey: "private_200", llm: { json: async (messages, options) => {
    assert.equal(options.task, "summary");
    assert.match(messages[1].content, /我记下了今天第/);
    assert.match(messages[0].content, /Synthetic fixture/);
    return { json: { reflections: [{ text: "我想慢慢理解这些担心。", evidence: [1, 2, 3] }] } };
  } } });
  assert.equal(result.created.length, 1);
  await life.writeDiary({ character, scopeKey: "private_200", date: today, llm: { chat: async (messages) => {
    assert.match(messages[1].content, /我记下了今天第/);
    assert.ok(!messages[1].content.includes("她在交流中"));
    return { text: "我想把今天的相处好好记住。" };
  } } });
  await assert.rejects(life.reflect({ character, scopeKey: "private_200", llm: { json: async () => {
    memory.editExtendedMemory(memory.listExtendedMemories()[0].id, "用户修正的事实");
    return { json: { reflections: [{ text: "我不能保存这个旧结论。", evidence: [1, 2, 3] }] } };
  } } }), /来源经历已修改/);
});

function soloSetup() {
  consent();
  const character = config.saveCharacter("record-fixture", {
    name: "Fixture", persona: "住在月港的舰娘，是用户的妻子。", worldview: "月港，禁止穿越到现实世界。",
    habits: "独处时读书、整理自己的笔记", relations: "与用户是排他的伴侣关系，不与第三者互动。",
  });
  config.saveConfig({ activeCharacter: character.id, life: { simulated: { enabled: true } } });
  const date = new Date();
  put(date.getTime() - 2 * 3600000);
  return { character, date };
}
const soloText = "我独自翻了几页书，又把散乱的笔记整理好，心里也慢慢安静下来。";
const soloReview = { allowed: true, solo: true, consistent: true, noNewRelationship: true };

test("her daily life is solo, persona-bound, once per day and never a factual interaction", async () => {
  const setup = soloSetup();
  const character = config.saveCharacter(setup.character.id, { persona: setup.character.persona + "设定细节。".repeat(1400) });
  const date = setup.date;
  const prompts = [];
  const llm = { json: async (messages) => {
    prompts.push(messages);
    return { json: prompts.length === 1 ? { text: soloText, participants: [] } : soloReview };
  } };
  const first = life.generateDailyLife({ character, date, llm });
  const duplicate = life.generateDailyLife({ character, date, llm });
  assert.equal(first, duplicate, "in-flight ticks must share one generation");
  const result = await first;
  assert.equal(result.ok, true);
  const row = db.one("select * from memories where id = ?", [result.added]);
  assert.equal(row.source_type, "simulated");
  assert.equal(row.content, soloText);
  assert.equal(memory.listExtendedMemories().length, 0);
  assert.match(life.dailyLifePromptBlock({ characterId: character.id, scopeKey: "private_200", accountId: "100" }), /设定内的独处日常/);
  assert.equal(life.dailyLifePromptBlock({ characterId: character.id, scopeKey: "group_300_200", accountId: "100" }), "");
  assert.equal(life.dailyLifePromptBlock({ characterId: character.id, scopeKey: "private_200", accountId: "999" }), "");
  assert.match(prompts[0][0].content, /用户的妻子/);
  assert.match(prompts[0][0].content, /月港/);
  assert.match(prompts[0][0].content, /与用户是排他的伴侣关系/);
  assert.match(prompts[1][0].content, /不能有任何第三方/);
  await life.generateDailyLife({ character, date, llm });
  assert.equal(prompts.length, 2, "a finished day is never generated twice");
});

test("her daily life is opt-in and never generated while the user is actively talking", async () => {
  const { character, date } = soloSetup();
  let calls = 0;
  const llm = { json: async () => { calls++; return { json: { text: soloText, participants: [] } }; } };
  config.saveConfig({ life: { simulated: { enabled: false } } });
  assert.equal((await life.generateDailyLife({ character, date, llm })).skipped, true);
  config.saveConfig({ life: { simulated: { enabled: true } } });
  put(date.getTime());
  assert.equal((await life.generateDailyLife({ character, date, llm })).skipped, true);
  assert.equal(calls, 0);
});

test("third-party fiction and a failed role-card review are not saved", async () => {
  for (const kind of ["third-party", "rejected-review"]) {
    const { character, date } = soloSetup();
    // Use a distinct day to avoid the intentional hourly failed-attempt backoff.
    if (kind === "rejected-review") date.setDate(date.getDate() + 1);
    let calls = 0;
    const llm = { json: async () => ({ json: ++calls === 1
      ? { text: kind === "third-party" ? "我和另一位男士一起约会，觉得很开心。" : soloText, participants: [] }
      : { ...soloReview, consistent: false } }) };
    assert.equal((await life.generateDailyLife({ character, date, llm })).skipped, true);
    assert.equal(db.one("select count(*) as n from memories where source_type = 'simulated'").n, 0);
  }
});

test("returning input, changed character card, revocation and clearing invalidate daily life in flight", async () => {
  for (const change of ["input", "card", "consent", "clear"]) {
    const { character, date } = soloSetup();
    date.setDate(date.getDate() + ["input", "card", "consent", "clear"].indexOf(change));
    let calls = 0;
    const llm = { json: async () => {
      calls++;
      if (calls === 2) {
        if (change === "input") put(date.getTime(), "我回来了");
        if (change === "card") config.saveCharacter(character.id, { relations: "用户已修改关系设定" });
        if (change === "consent") config.saveConfig({ nextMemory: { consentDigest: "" } });
        if (change === "clear") db.run("insert or replace into scope_resets values('private_200', 1, ?)", [Date.now()]);
      }
      return { json: calls === 1 ? { text: soloText, participants: [] } : soloReview };
    } };
    await assert.rejects(life.generateDailyLife({ character, date, llm }), /变化|修改|回来|清空/);
    assert.equal(db.one("select count(*) as n from memories where source_type = 'simulated'").n, 0);
  }
});

test("large daily archive consumes every source message once, including arrivals during generation", async () => {
  consent();
  for (let n = 0; n < 260; n++) put(yesterday.getTime() + n, `marker-${n};`);
  const inputs = [];
  const llm = {
    json: async (messages) => {
      inputs.push(messages[1].content);
      if (inputs.length === 1) put(yesterday.getTime() + 300, "late-arrival;");
      return { json: { summary: "CUMULATIVE_SYNTHETIC_SUMMARY" } };
    },
  };
  for (let n = 0; n < 5; n++) await memory.archiveExtendedDaily(llm);
  const transcript = inputs.join("\n");
  for (let n = 0; n < 260; n++)
    assert.equal(transcript.split(`marker-${n};`).length - 1, 1, `source ${n} must appear once`);
  assert.equal(transcript.split("late-arrival;").length - 1, 1);
  const calls = inputs.length;
  await memory.archiveExtendedDaily(llm);
  assert.equal(inputs.length, calls, "no new source must mean no extra model request");
});

test("changing or deleting a daily memory while generation is running cannot restore stale content", async () => {
  consent();
  put();
  put();
  const llm = { json: async () => ({ json: { summary: "ORIGINAL_SYNTHETIC" } }) };
  await memory.archiveExtendedDaily(llm);
  const id = memory.listExtendedMemories()[0].id;
  for (let n = 0; n < 12; n++) put();
  await memory.archiveExtendedDaily({
    json: async () => {
      memory.editExtendedMemory(id, "MANUAL_CORRECTION");
      return { json: { summary: "STALE_GENERATION" } };
    },
  });
  assert.equal(memory.listExtendedMemories()[0].content, "MANUAL_CORRECTION");
  memory.editExtendedMemory(id, "");
  await memory.archiveExtendedDaily(llm);
  assert.equal(memory.listExtendedMemories().length, 0);
  assert.equal(life.lifeSnapshot({ characterId: "record-fixture" }).experienceDays.length, 0);
});

test("revoking consent in flight does not advance the cursor and a later retry can recover", async () => {
  consent();
  put();
  put();
  await memory.archiveExtendedDaily({
    json: async () => {
      config.saveConfig({ nextMemory: { consentDigest: "" } });
      return { json: { summary: "MUST_NOT_PERSIST" } };
    },
  });
  assert.equal(memory.listExtendedMemories().length, 0);
  consent();
  await memory.archiveExtendedDaily({ json: async () => ({ json: { summary: "RETRIED" } }) });
  assert.equal(memory.listExtendedMemories()[0].content, "RETRIED");
});

test("small current-day additions coalesce, manual archive can flush, and failed summaries remain pending", async () => {
  consent();
  put();
  put();
  let calls = 0;
  const llm = {
    json: async () => {
      calls++;
      return { json: { summary: "UPDATED" } };
    },
  };
  await memory.archiveExtendedDaily(llm, new Date());
  put();
  await memory.archiveExtendedDaily(llm, new Date());
  assert.equal(calls, 1);
  await memory.archiveExtendedDaily(llm, new Date(), { force: true });
  assert.equal(calls, 2);
  put();
  assert.equal((await memory.archiveExtendedDaily(
      {
        json: async () => {
          throw new Error("SYNTHETIC_FAILURE");
        },
      },
      new Date(),
      { force: true },
    )).failed, 1);
  await memory.archiveExtendedDaily(llm, new Date(), { force: true });
  assert.equal(calls, 3);
});

test("upgrade rebuilds an older automatic summary from retained original messages and preserves manual edits", async () => {
  consent();
  for (let n = 0; n < 160; n++) put(yesterday.getTime() + n, `upgrade-source-${n};`);
  const digest = (await import("../lib/service-http.mjs")).digest;
  const day = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;
  const id = digest(["record-fixture", "100", "private_200", 0, day]);
  const revision = digest([id, "OLD_TRUNCATED_SUMMARY"]);
  db.run(
    "insert into hindsight_records(id, character_id, account_id, scope_key, generation, day, content, bank_id, revision, updated_at) values(?, 'record-fixture', '100', 'private_200', 0, ?, 'OLD_TRUNCATED_SUMMARY', ?, ?, ?)",
    [id, day, `he-${revision}`, revision, Date.now()],
  );
  const inputs = [];
  const llm = {
    json: async (messages) => {
      inputs.push(messages[1].content);
      return { json: { summary: "REBUILT_SYNTHETIC" } };
    },
  };
  await memory.archiveExtendedDaily(llm);
  await memory.archiveExtendedDaily(llm);
  assert.ok(inputs[0].includes("upgrade-source-0;"));
  assert.ok(inputs[1].includes("upgrade-source-159;"));
  assert.equal(memory.listExtendedMemories().length, 1);
  memory.editExtendedMemory(id, "USER_EDITED_SUMMARY");
  db.run("delete from meta where key = ?", [`daily-source:${id}`]);
  await memory.archiveExtendedDaily(llm);
  assert.equal(inputs.length, 2);
  assert.equal(memory.listExtendedMemories()[0].content, "USER_EDITED_SUMMARY");
});

test("writing another day's diary never retires a previous day's diary in the same scope", async () => {
  consent();
  put();
  put();
  const llm = {
    json: async () => ({ json: { summary: "TODAY_SUMMARY" } }),
    chat: async () => ({ text: "今天的相处让我很开心，我会珍惜这段时光。" }),
  };
  await memory.archiveExtendedDaily(llm);
  const previous = (await import("../lib/memory.mjs")).addMemory({
    scopeKey: "private_200",
    characterId: character.id,
    content: "[日记 2026-01-01] 过去的日记",
    category: "diary",
    sourceType: "diary",
  });
  await life.writeDiary({ llm, character, scopeKey: "private_200", date: today });
  assert.equal(db.one("select status from memories where id = ?", [previous.id]).status, "active");
  assert.equal(life.listDiary({ characterId: character.id }).length, 2);
});

test("extended memory feeds due diaries per private scope, retries an empty day, and never merges scopes", async () => {
  consent();
  const due = new Date();
  due.setHours(23, 0, 0, 0);
  const prompts = [];
  const llm = {
    json: async (messages) => ({
      json: { summary: messages[1].content.includes("OTHER_SCOPE") ? "OTHER_SCOPE_SUMMARY" : "OWN_SCOPE_SUMMARY" },
    }),
    chat: async (messages, options) => {
      prompts.push({ text: messages[1].content, options });
      return { text: "今天我们一起聊了许多事情，我想把这份心情记下来。" };
    },
  };
  await life.writeDueDiaries({ llm, character, date: due });
  assert.equal(prompts.length, 0);
  put();
  put();
  storage.insertMessage({
    eventKey: "other-scope",
    scopeKey: "private_201",
    characterId: "record-fixture",
    accountId: "100",
    direction: "in",
    at: today.getTime(),
    body: "OTHER_SCOPE",
  });
  await memory.archiveExtendedDaily(llm, due);
  await life.writeDueDiaries({ llm, character, date: due });
  assert.equal(prompts.length, 2);
  assert.ok(prompts.every((p) => !(p.text.includes("OWN_SCOPE_SUMMARY") && p.text.includes("OTHER_SCOPE_SUMMARY"))));
  assert.ok(prompts.every((p) => p.options.task === "summary"));
  await life.writeDueDiaries({ llm, character, date: due });
  assert.equal(prompts.length, 2, "restart/minute ticks must not duplicate a finished diary");
});
