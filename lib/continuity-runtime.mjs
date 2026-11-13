import { all, one, run } from "./db.mjs";
import { getConfig, loadCharacter } from "./config.mjs";
import { enrichConversations } from "./cognition.mjs";
import { archiveExtendedDaily, memoryConsentValid, memoryDisclosure } from "./extended-memory.mjs";
import { reflect } from "./life.mjs";
import { iterateCharacter } from "./character-evolution.mjs";
import { advanceBody } from "./body-state.mjs";
import { createLogger } from "./log.mjs";
const log = createLogger("Continuity");
let running = false;
export async function runContinuity(llm, now = Date.now()) {
  if (running || getConfig().life?.enabled === false) return { skipped: true };
  running = true;
  try {
    const allowed = () => getConfig().life?.enabled !== false && getConfig().nextMemory.enabled && memoryConsentValid();
    if (getConfig().life?.archive?.enabled !== false) await archiveExtendedDaily(llm, new Date(now));
    const evaluation = await enrichConversations(
      llm,
      { allowed, fingerprint: () => memoryDisclosure().fingerprint },
      now,
    );
    if (evaluation.failed) log.warn(`对话评估暂未完成 ${evaluation.failed} 条，已保留待重试记录`);
    for (const row of all("select character_id from body_profiles")) advanceBody(row.character_id, new Date(now));
    const scopes = all(
      `select o.character_id,o.account_id,o.scope_key,max(m.at) as last_at from message_origins o join messages m on m.event_key=o.event_key
      where o.character_id<>'' and m.at>? group by o.character_id,o.account_id,o.scope_key order by last_at desc limit 30`,
      [now - 30 * 86400000],
    );
    for (const scope of scopes) {
      const cfg = getConfig();
      if (
        cfg.life?.enabled === false ||
        cfg.life?.reflection?.enabled === false ||
        (cfg.nextMemory.enabled && !allowed())
      )
        break;
      const key = "reflection-due:" + JSON.stringify([scope.character_id, scope.account_id, scope.scope_key]);
      const last = Number(one("select value from meta where key=?", [key])?.value) || 0;
      if (now - last < Math.max(1, Number(cfg.life?.reflection?.everyHours) || 24) * 3600000) continue;
      try {
        const character = loadCharacter(scope.character_id);
        const result = await reflect({
          llm,
          character,
          scopeKey: scope.scope_key,
          masterId: cfg.bot.masterId,
          masterName: cfg.bot.masterName,
          accountId: scope.account_id,
        });
        run("insert or replace into meta values(?,?)", [key, String(now)]);
        const evolution = iterateCharacter(character.id, scope.account_id, scope.scope_key, now);
        if (!result.skipped || evolution.ok) log.info(`归档后的反思检查完成；${result.summary}；${evolution.summary}`);
      } catch (error) {
        log.warn(
          `反思暂未完成：${error.kind || error.code || "model_or_source_unavailable"}，保留原始记录等待下次整理`,
        );
      }
    }
    return { ok: true, evaluation };
  } finally {
    running = false;
  }
}
