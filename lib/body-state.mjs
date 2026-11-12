/** Calendar-based fictional physiology. Probabilities are game parameters, not medical risk estimates. */
import { createHash, randomUUID } from "node:crypto";
import { one, run, all, tx } from "./db.mjs";
import { dayKey } from "./util.mjs";

const REGIONS = ["呼吸系统", "消化系统", "头部", "肌肉关节"];
const DAY = 86400000;
const ordinal = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("日期格式应为 YYYY-MM-DD");
  const n = Date.parse(value + "T00:00:00Z");
  if (!Number.isFinite(n) || new Date(n).toISOString().slice(0, 10) !== value) throw new Error("日期不存在");
  return n / DAY;
};
const dateOf = (n) => new Date(n * DAY).toISOString().slice(0, 10);
const random = (seed, key) =>
  createHash("sha256")
    .update(seed + ":" + key)
    .digest()
    .readUInt32BE(0) / 4294967296;
const bounded = (n, min, max) => {
  n = Number(n);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`数值应在 ${min}–${max} 之间`);
  return Math.round(n);
};

export function enableBody(character, input, now = new Date()) {
  if (one("select 1 from body_profiles where character_id=?", [character.id]))
    throw new Error("身体系统已启用，初始值已保存，不能重复初始化或关闭");
  if (input.confirmIrreversible !== true) throw new Error("请确认启用后不可关闭");
  const today = dayKey(now),
    start = String(input.cycleStart || today);
  ordinal(start);
  if (start > today || ordinal(today) - ordinal(start) > 366) throw new Error("周期起始日需在过去一年内");
  const profile = {
    constitution: bounded(input.constitution ?? 70, 1, 100),
    conditions: String(input.conditions || "").slice(0, 1000),
    cycleEnabled: input.cycleEnabled === true,
    cycleStart: start,
    cycleLength: bounded(input.cycleLength ?? 28, 18, 60),
    periodDays: bounded(input.periodDays ?? 5, 1, 10),
    variation: bounded(input.variation ?? 2, 0, 5),
    manifestations: String(input.manifestations || "轻微疲倦，按自己的状态休息").slice(0, 300),
    // Store the relevant original setting; later card edits cannot reroll past events.
    characterSetting: String(character.persona || "").slice(0, 4000),
    seed: randomUUID(),
    enabledDay: today,
  };
  if (profile.periodDays >= profile.cycleLength - profile.variation) throw new Error("经期长度必须小于最短周期");
  run("insert into body_profiles(character_id,profile_json,created_at) values(?,?,?)", [
    character.id,
    JSON.stringify(profile),
    now.getTime(),
  ]);
  return bodySnapshot(character.id, today.slice(0, 7), now);
}

export function cycleAt(profile, day) {
  if (!profile.cycleEnabled) return { phase: "不适用", cycleDay: null };
  let start = ordinal(profile.cycleStart),
    target = ordinal(day),
    index = 0,
    length;
  if (target < start) return { phase: "尚无记录", cycleDay: null };
  while (true) {
    length = profile.cycleLength + Math.round((random(profile.seed, "cycle:" + index) * 2 - 1) * profile.variation);
    if (target < start + length) break;
    start += length;
    index++;
  }
  const cycleDay = target - start + 1;
  const next = start + length;
  // Calendar approximation only: ovulation is an event, not a week-long phase.
  // NHS gives roughly 10–16 days before the next period. Use 14 as a simulation anchor.
  const estimated = next - 14,
    earliest = next - 16,
    latest = next - 10;
  const reliable = earliest >= start + profile.periodDays;
  const menstruating = cycleDay <= profile.periodDays;
  const phase = menstruating
    ? "经期"
    : !reliable
      ? "阶段不确定"
      : target < estimated
        ? "卵泡期"
        : target === estimated
          ? "排卵期（预计）"
          : "黄体期";
  const ovarianPhase = !reliable
    ? "不确定"
    : target < estimated
      ? "卵泡期"
      : target === estimated
        ? "排卵（预计）"
        : "黄体期";
  const subphase = phase === "黄体期" ? (next - target <= 7 ? "黄体晚期（经前）" : "黄体早期") : phase;
  const descriptions = {
    经期: "子宫内膜脱落形成月经；经期通常与卵巢的卵泡期重叠。表现以初始设定和已记录状态为准。",
    卵泡期: "卵泡发育，雌激素通常逐渐上升，子宫内膜逐渐增厚；不据此保证精力或情绪变化。",
    "排卵期（预计）": "预计处于卵子释放前后，分泌物可能更清亮、富有延展性，也可能没有明显感受。日历不能确认排卵。",
    黄体早期: "排卵后黄体形成，孕酮通常上升；基础体温可能略升，但这里没有测量体温或激素。",
    "黄体晚期（经前）":
      "在未妊娠的模拟设定中，临近下一次月经，激素水平回落；可能腹胀、乳房胀痛或疲倦，也可无明显不适。",
    阶段不确定: "当前周期长度与经期设定不足以支持常规排卵估算，仅保留经期日历，不强行推定卵泡或黄体阶段。",
  };
  return {
    cycleVersion: 2,
    phase,
    subphase,
    ovarianPhase,
    cycleDay,
    cycleLength: length,
    cycleStart: dateOf(start),
    nextPeriod: dateOf(next),
    ovulation: reliable
      ? { estimatedDay: dateOf(estimated), earliest: dateOf(earliest), latest: dateOf(latest) }
      : null,
    inOvulationWindow: reliable && target >= earliest && target <= latest,
    phaseDescription: descriptions[subphase],
    estimateNotice: "阶段为日历估算；窗口表示排卵日期的不确定范围，不是持续排卵或避孕安全期。",
  };
}

// Read-time enrichment leaves dev.16 persisted JSON and its illness history intact.
function withCycleDetails(profile, day, record) {
  if (!record) return cycleAt(profile, day);
  if (record.cycleVersion || !profile.cycleEnabled) return record;
  const details = cycleAt(profile, day);
  const expected = details.cycleDay <= profile.periodDays ? "经期" : "非经期";
  if (record.cycleDay !== details.cycleDay || record.phase !== expected) return record;
  return { ...record, ...details, legacyPhase: record.phase };
}

export function bodyRisks(profile) {
  return REGIONS.map((region) => ({
    region,
    dailyProbability: Math.min(
      0.025,
      0.002 *
        (1 + (100 - profile.constitution) / 30) *
        (profile.conditions.includes(region) || profile.characterSetting.includes(region) ? 1.5 : 1),
    ),
  }));
}

export function advanceBody(characterId, now = new Date()) {
  const row = one("select * from body_profiles where character_id=?", [characterId]);
  if (!row) return null;
  const profile = JSON.parse(row.profile_json),
    today = dayKey(now);
  const last = one("select max(day) as day from body_days where character_id=?", [characterId])?.day;
  const first = last ? ordinal(last) + 1 : ordinal(profile.enabledDay),
    end = ordinal(today);
  // Never overwrite recorded history on clock rollback. Catch up in bounded batches.
  tx(() => {
    for (let n = first; n <= Math.min(end, first + 3659); n++) {
      const day = dateOf(n),
        issues = [];
      for (const risk of bodyRisks(profile)) {
        // Independent onset, deterministic duration; no fatal or permanent events are fabricated.
        for (let offset = 0; offset < 4; offset++) {
          const onset = dateOf(n - offset);
          if (onset < profile.enabledDay) continue;
          const duration = 1 + Math.floor(random(profile.seed, "duration:" + risk.region + onset) * 4);
          if (offset < duration && random(profile.seed, "illness:" + risk.region + onset) < risk.dailyProbability) {
            issues.push({ region: risk.region, severity: "轻微不适", remainingDays: duration - offset });
            break;
          }
        }
      }
      run("insert or ignore into body_days(character_id,day,state_json) values(?,?,?)", [
        characterId,
        day,
        JSON.stringify({ ...cycleAt(profile, day), issues }),
      ]);
    }
  });
  return {
    profile,
    today: (() => {
      const saved = one("select state_json from body_days where character_id=? and day=?", [characterId, today]);
      return saved ? withCycleDetails(profile, today, JSON.parse(saved.state_json)) : null;
    })(),
  };
}

export function bodySnapshot(characterId, month = dayKey().slice(0, 7), now = new Date()) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("月份格式应为 YYYY-MM");
  const state = advanceBody(characterId, now);
  if (!state) return { enabled: false, month };
  const records = new Map(
    all("select * from body_days where character_id=? and day like ?", [characterId, month + "-%"]).map((r) => [
      r.day,
      JSON.parse(r.state_json),
    ]),
  );
  const days = [],
    count = new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0).getDate();
  for (let n = 1; n <= count; n++) {
    const day = month + "-" + String(n).padStart(2, "0"),
      record = records.get(day);
    days.push({
      day,
      ...withCycleDetails(state.profile, day, record),
      recorded: Boolean(record),
      issues: record?.issues || [],
      status: record ? "已记录" : day > dayKey(now) ? "预计" : "未启用或待补记",
    });
  }
  const { seed: _seed, ...profile } = state.profile;
  return { enabled: true, month, profile, today: state.today, days, risks: bodyRisks(state.profile) };
}

export function bodyPrompt(characterId, now = new Date()) {
  const state = advanceBody(characterId, now);
  if (!state?.today) return "";
  const { profile, today } = state;
  const cycle = today.cycleVersion
    ? `\n${today.estimateNotice} ${today.phaseDescription} ${today.subphase !== today.phase ? today.subphase + "。" : ""}下次经期预计 ${today.nextPeriod}。${today.ovulation ? "排卵日期估算范围 " + today.ovulation.earliest + " 至 " + today.ovulation.latest + "。" : ""}上述可能表现不代表已经发生，不写成症状记录、诊断或必然情绪，不推断怀孕或生育能力。`
    : "";
  return `【你的身体状态（设定内模拟，不是用户健康信息）】\n体质 ${profile.constitution}/100；先天设定：${profile.conditions || "未设定"}。今天：${today.phase}${today.cycleDay ? "，周期第" + today.cycleDay + "天" : ""}；${today.issues.map((x) => x.region + x.severity).join("、") || "无新增不适"}。${today.phase === "经期" ? profile.manifestations : ""}${cycle}\n只在相关话题中自然表达，不必每轮提起；不得据此替对方诊断，不将生理期等同于特定情绪。`;
}
