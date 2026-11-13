/** Bounded character-card growth: original identity is immutable; only audited behavioral additions evolve. */
import { ownsReflection } from "./reflection-evidence.mjs";
import { all, one, run, tx } from "./db.mjs";
import { loadCharacter } from "./config.mjs";

const TRAITS = {
  care: "遇到对方明确提到作息不规律时，先体谅，再适度关心休息；不监督、不反复催促。",
  attention: "更留心对方已经明确告诉自己的重要信息和喜好；只在当前会话有依据时自然回应。",
  reliability: "更重视已有约定；先核对当前会话的具体内容，不凭空许诺或虚构完成情况。",
};

export function evolutionSnapshot(characterId) {
  const row = one("select * from character_evolution where character_id=?", [characterId]);
  if (!row) return { enabled: false, count: 0, lastAt: null, traits: [], original: null };
  return {
    enabled: Boolean(row.enabled),
    count: row.iterations,
    lastAt: row.last_at || null,
    original: JSON.parse(row.original_json),
    traits: JSON.parse(row.traits_json),
    history: all("select * from evolution_history where character_id=? order by at desc limit 20", [characterId]),
  };
}

export function setEvolution(characterId, enabled) {
  if (!enabled && !one("select 1 from character_evolution where character_id=?", [characterId]))
    return evolutionSnapshot(characterId);
  const original = loadCharacter(characterId);
  run(
    `insert into character_evolution(character_id,enabled,original_json,traits_json,iterations,last_at) values(?,?,?,'[]',0,0)
    on conflict(character_id) do update set enabled=excluded.enabled`,
    [characterId, enabled ? 1 : 0, JSON.stringify(original)],
  );
  return evolutionSnapshot(characterId);
}

export function evaluateEvolution(evidence, reflections) {
  const valid = evidence.filter((e) => e.confidence >= 0.8 && e.importance >= 0.7);
  const candidates = [
    ["care", "routine"],
    ["attention", null],
    ["reliability", "agreement"],
  ];
  const proposals = [];
  for (const [trait, category] of candidates) {
    const sources = valid.filter((e) => !category || e.category === category);
    const ids = [...new Set(sources.map((e) => e.message_id))];
    // Reflections must cite evidence in the same scope; a single statement never changes the character.
    if (ids.length < 3 || !reflections.some((r) => r.confidence >= 0.7 && r.evidence_count >= 3)) continue;
    const score = sources.reduce((sum, e) => sum + (e.confidence + e.importance) / 2, 0) / sources.length;
    if (score >= 0.8) proposals.push({ trait, text: TRAITS[trait], score, evidence: ids.slice(0, 20) });
  }
  return proposals;
}

export function iterateCharacter(characterId, accountId, scopeKey, now = Date.now()) {
  const state = evolutionSnapshot(characterId);
  if (!state.enabled) return { skipped: true, summary: "她的迭代尚未开启" };
  if (state.lastAt && now - state.lastAt < 86400000)
    return { skipped: true, summary: "距离上次迭代不足一天，继续积累经历" };
  const evidence = all(
    "select * from conversation_facts where character_id=? and account_id=? and scope_key=? and at>? order by at desc limit 100",
    [characterId, accountId, scopeKey, state.lastAt || 0],
  );
  const refs = all("select * from reflections where character_id=? and scope_key=? and at>?", [
    characterId,
    scopeKey,
    state.lastAt || 0,
  ]).filter((row) => ownsReflection(row, accountId));
  const proposal = evaluateEvolution(evidence, refs).find((p) => !state.traits.some((t) => t.trait === p.trait));
  if (!proposal) return { skipped: true, summary: "尚无足够证据支持新的适度变化" };
  // Whitelisted traits carry no private names, dates, diagnoses, or relationship changes into the shared card.
  tx(() => {
    run("update character_evolution set traits_json=?,iterations=iterations+1,last_at=? where character_id=?", [
      JSON.stringify([...state.traits, proposal]),
      now,
      characterId,
    ]);
    run("insert into evolution_history(character_id,scope_key,change_json,at) values(?,?,?,?)", [
      characterId,
      scopeKey,
      JSON.stringify(proposal),
      now,
    ]);
  });
  return { ok: true, summary: "已形成一项有依据的行为成长，原始人设已保留", proposal };
}

export function evolutionPrompt(characterId) {
  const state = evolutionSnapshot(characterId);
  if (!state.enabled || !state.traits.length) return "";
  return (
    "【她的迭代：角色卡的成长补充】\n" +
    state.traits.map((t) => t.text).join("\n") +
    "\n这些只是温和的行为倾向。原始身份、世界观、性格、说话方式、关系与边界优先；不要改变原始事实，也不要自行升级关系。"
  );
}
