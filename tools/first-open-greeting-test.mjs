import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "heartecho-first-open-"));
for (const key of Object.keys(process.env)) if (key.startsWith("HEARTECHO_")) delete process.env[key];
Object.assign(process.env, { HEARTECHO_APP_DIR: tmp, HEARTECHO_DATA_DIR: path.join(tmp, "data"), HEARTECHO_LOG_DIR: path.join(tmp, "logs"), HEARTECHO_LOG_LEVEL: "error" });
const { ensureDirs, paths } = await import("../lib/paths.mjs");
ensureDirs();
const db = await import("../lib/db.mjs");
db.getDb();
const config = await import("../lib/config.mjs");
const { Scheduler, jobDone } = await import("../lib/scheduler.mjs");
const { localPeer, localScope } = await import("../lib/local-channel.mjs");
const { pauseState, blockPeer } = await import("../lib/policy.mjs");
const weather = await import("../lib/weather.mjs");
const { dayKey } = await import("../lib/util.mjs");
const date = () => new Date();
function cacheWeather({ day = dayKey(date()), warning = "" } = {}) {
  fs.writeFileSync(path.join(paths.state, "weather.json"), JSON.stringify({ forecastAt: Date.now(), forecast: {
    ok: true, city: "测试港", warning, fetchedAt: Date.now(),
    today: { date: day, text: "中雨", min: 12, max: 19, rainProb: 90, code: 63, windMax: 20 },
  } }));
}
let calls, sends, reply, client, scheduler;
function makeScheduler() {
  return new Scheduler({ client, llm: { status: () => ({ ready: true }), speak: async (character, prompt, options) => {
    calls.push({ character, prompt, options });
    return reply();
  } } });
}
beforeEach(() => {
  for (const table of ["messages", "message_origins", "sessions", "outgoing", "scheduled_jobs", "job_runs", "blocklist", "scope_resets", "meta"]) db.run(`delete from ${table}`);
  config.saveCharacter("first", { name: "小语", persona: "港区的舰娘", speechStyle: "称呼对方指挥官" });
  config.saveCharacter("second", { name: "另一位", persona: "独立角色" });
  config.saveConfig({ activeCharacter: "first", bot: { selfId: 10000001, masterId: 10000002 }, life: { enabled: false }, nextMemory: { enabled: false }, weather: { enabled: true, proactive: { enabled: false, onlyOnAlert: false } }, greet: { firstOpen: { enabled: true, channel: "local" }, morning: { enabled: false }, noon: { enabled: false }, night: { enabled: false }, holidays: { enabled: false }, birthdays: { enabled: false }, proactive: { enabled: false }, reminders: { enabled: false } } });
  pauseState.set(false);
  weather.clearWeatherFeedback();
  cacheWeather();
  calls = []; sends = [];
  reply = async () => ({ text: "指挥官，你来啦。今天预报有雨，出门记得带伞。" });
  client = { selfId: 10000001, online: true, status: { online: true, selfId: 10000001 }, sendPrivateMsg: async (peer, text) => { sends.push({ peer, text }); return { message_id: "fixture" }; } };
  scheduler = makeScheduler();
});
after(() => { db.closeDb(); fs.rmSync(tmp, { recursive: true, force: true }); });

test("first open combines a persona greeting and real weather once across reopen, concurrency and restart", async () => {
  let release;
  reply = () => new Promise(resolve => { release = resolve; });
  const task = scheduler.greetOnOpen();
  const duplicate = scheduler.greetOnOpen();
  assert.equal(task, duplicate);
  for (let n = 0; n < 20 && !release; n++) await new Promise(resolve => setTimeout(resolve, 5));
  release({ text: "指挥官，今天预报有雨，出门记得带伞。" });
  assert.ok((await task).sent);
  assert.equal(calls.length, 1);
  assert.match(calls[0].prompt, /测试港今天中雨/);
  assert.equal(calls[0].character.id, "first");
  assert.equal(sends.length, 0, "default channel must never send to QQ");
  const messages = db.all("select * from messages");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].scope_key, localScope("first"));
  assert.equal(messages[0].direction, "out");
  assert.equal(messages[0].account_id, undefined); // identity lives in message_origins
  assert.equal(db.one("select account_id from message_origins").account_id, "heartecho-local");
  await scheduler.greetOnOpen();
  db.closeDb(); db.getDb();
  await makeScheduler().greetOnOpen();
  assert.equal(calls.length, 1);
  assert.ok(jobDone(`weather:${dayKey(date())}:${localPeer("first")}`));
});

test("disabled option and silent scheduler ticks never create a first-open greeting", async () => {
  await scheduler.tick();
  assert.equal(calls.length, 0);
  config.saveConfig({ greet: { firstOpen: { enabled: false } } });
  await scheduler.greetOnOpen();
  assert.equal(calls.length, 0);
});

test("next local day becomes eligible, while yesterday's cached forecast is never called today's weather", async () => {
  await scheduler.greetOnOpen();
  const tomorrow = date(); tomorrow.setDate(tomorrow.getDate() + 1);
  await scheduler.greetOnOpen(tomorrow);
  assert.equal(calls.length, 2);
  assert.ok(!calls[1].prompt.includes("测试港今天中雨"));
  assert.match(calls[1].prompt, /不要.*天气|不.*编造/);
});

test("weather failure, weather mute and already-sent weather leave a greeting without fabricated or repeated forecasts", async () => {
  for (const kind of ["failed", "muted", "already-sent", "disabled"]) {
    db.run("delete from job_runs"); db.run("delete from outgoing");
    config.saveConfig({ weather: { enabled: kind !== "disabled" } });
    weather.clearWeatherFeedback(); cacheWeather({ warning: kind === "failed" ? "unavailable" : "" });
    if (kind === "muted") weather.recordWeatherFeedback({ type: "stop" });
    if (kind === "already-sent") (await import("../lib/scheduler.mjs")).claimJob(`weather:${dayKey(date())}:${localPeer("first")}`);
    await scheduler.greetOnOpen();
    assert.ok(!calls.at(-1).prompt.includes("测试港今天中雨"), kind);
  }
});

test("turning off, clearing, changing role/QQ account or muting weather during generation cancels stale delivery", async () => {
  for (const kind of ["disable", "clear", "role", "account", "mute", "card"]) {
    db.run("delete from job_runs"); db.run("delete from outgoing"); db.run("delete from messages");
    config.saveConfig({ activeCharacter: "first", bot: { selfId: 10000001 }, greet: { firstOpen: { enabled: true } } });
    weather.clearWeatherFeedback(); cacheWeather();
    reply = async () => {
      if (kind === "disable") config.saveConfig({ greet: { firstOpen: { enabled: false } } });
      if (kind === "clear") db.run("insert or replace into scope_resets values(?, ?, ?)", [localScope("first"), 9, Date.now()]);
      if (kind === "role") config.saveConfig({ activeCharacter: "second" });
      if (kind === "account") config.saveConfig({ bot: { selfId: 10000003 } });
      if (kind === "mute") weather.recordWeatherFeedback({ type: "stop" });
      if (kind === "card") config.saveCharacter("first", { persona: "改过的人设" });
      return { text: "STALE" };
    };
    await scheduler.greetOnOpen();
    assert.equal(db.one("select count(*) as n from messages").n, 0, kind);
    assert.equal(jobDone(`first-open:${dayKey(date())}`), false, kind);
  }
});

test("pause and blocklist suppress generation; model failures remain retryable; unknown sends never retry", async () => {
  pauseState.set(true);
  await scheduler.greetOnOpen(); assert.equal(calls.length, 0);
  pauseState.set(false);
  blockPeer({ scopeKind: "global", peerId: localPeer("first") });
  await scheduler.greetOnOpen(); assert.equal(calls.length, 0);
  db.run("delete from blocklist");
  reply = async () => { throw new Error("MODEL_FAILURE"); };
  await assert.rejects(scheduler.greetOnOpen(), /MODEL_FAILURE/);
  assert.equal(jobDone(`first-open:${dayKey(date())}`), false);
  config.saveConfig({ greet: { firstOpen: { channel: "qq" } } });
  reply = async () => ({ text: "QQ_GREETING" });
  client.sendPrivateMsg = async () => { sends.push({}); throw new Error("UNKNOWN_SEND"); };
  scheduler = makeScheduler();
  await scheduler.greetOnOpen();
  await makeScheduler().greetOnOpen();
  assert.equal(sends.length, 1);
  assert.equal(db.one("select status from outgoing").status, "unknown");
});

test("QQ first-open waits briefly for the configured account, never queues into an offline or wrong account", async () => {
  config.saveConfig({ greet: { firstOpen: { channel: "qq" } } });
  client.online = false; client.status.online = false;
  await scheduler.greetOnOpen();
  assert.equal(calls.length, 0);
  client.online = true; client.status.online = true; client.status.selfId = 10000003;
  await scheduler.retryOpenGreeting(); assert.equal(calls.length, 0);
  client.status.selfId = 10000001;
  await scheduler.retryOpenGreeting();
  assert.equal(sends.length, 1);
  assert.equal(sends[0].peer, "10000002");
});

test("an expired QQ opening and a background restart cannot send a late welcome", async () => {
  config.saveConfig({ greet: { firstOpen: { channel: "qq" } } });
  client.online = false;
  const opened = date();
  await scheduler.greetOnOpen(opened);
  client.online = true;
  await scheduler.retryOpenGreeting(new Date(opened.getTime() + 11 * 60000));
  await makeScheduler().retryOpenGreeting();
  assert.equal(calls.length, 0);
  assert.equal(sends.length, 0);
  await scheduler.greetOnOpen();
  assert.equal(sends.length, 1, "a new actual opening can still greet");
});

test("changing role while waiting for QQ cancels the original opening instead of greeting as another role", async () => {
  config.saveConfig({ greet: { firstOpen: { channel: "qq" } } });
  client.online = false;
  await scheduler.greetOnOpen();
  config.saveConfig({ activeCharacter: "second" });
  client.online = true;
  await scheduler.retryOpenGreeting();
  assert.equal(calls.length, 0);
  assert.equal(sends.length, 0);
});

test("crossing midnight during generation cancels the old day's greeting without consuming tomorrow", async () => {
  const actualNow = Date.now;
  const started = date();
  reply = async () => { Date.now = () => actualNow() + 86400000; return { text: "YESTERDAY" }; };
  try { await scheduler.greetOnOpen(started); } finally { Date.now = actualNow; }
  assert.equal(db.one("select count(*) as n from messages").n, 0);
  assert.equal(jobDone(`first-open:${dayKey(started)}`), false);
  assert.equal(jobDone(`weather:${dayKey(started)}:${localPeer("first")}`), false);
});
