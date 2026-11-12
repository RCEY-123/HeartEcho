import { all, run } from "./db.mjs";
import { activeCharacterId, loadCharacter, getConfig } from "./config.mjs";
import { cognitionSnapshot } from "./cognition.mjs";
import { enableBody, bodySnapshot } from "./body-state.mjs";
import { evolutionSnapshot, setEvolution, iterateCharacter } from "./character-evolution.mjs";
import { runContinuity } from "./continuity-runtime.mjs";
import { runJob } from "./jobs.mjs";
import { localScope, accountForPeer } from "./local-channel.mjs";
import { scopeLabel } from "./storage.mjs";
import { memoryConsentValid, memoryDisclosure } from "./extended-memory.mjs";
export async function continuityApi(route, url, body, { llm }) {
  const characterId = String(body.characterId || url.searchParams.get("characterId") || activeCharacterId());
  const character = loadCharacter(characterId);
  if (route === "GET /api/continuity") {
    const scopes = all(
      `select o.scope_key as value,max(m.at) as at from messages m join message_origins o on o.event_key=m.event_key where o.character_id=? group by o.scope_key order by at desc`,
      [characterId],
    );
    if (!scopes.length) scopes.push({ value: localScope(characterId) });
    return {
      ok: true,
      characterId,
      cognition: cognitionSnapshot(characterId),
      body: bodySnapshot(characterId, url.searchParams.get("month") || undefined),
      evolution: evolutionSnapshot(characterId),
      scopes: scopes.map((s) => ({
        ...s,
        label: scopeLabel(s.value, { masterId: getConfig().bot.masterId, masterName: getConfig().bot.masterName }),
      })),
      memory: {
        enabled: getConfig().nextMemory.enabled,
        consentValid: memoryConsentValid(),
        disclosure: memoryDisclosure(),
      },
    };
  }
  if (route === "POST /api/continuity/body") return { ok: true, body: enableBody(character, body) };
  if (route === "POST /api/continuity/evolution")
    return { ok: true, evolution: setEvolution(characterId, body.enabled === true) };
  if (route === "POST /api/continuity/iterate") {
    const scope = String(body.scopeKey || localScope(characterId));
    return {
      ok: true,
      ...iterateCharacter(characterId, accountForPeer(scope.slice(8), getConfig().bot.selfId), scope),
    };
  }
  if (route === "POST /api/continuity/process")
    return { ok: true, ...runJob("continuity", "整理对话、归档与反思", () => runContinuity(llm)) };
  if (route === "POST /api/continuity/forget") {
    run(
      "insert or ignore into forgotten_fact_sources select message_id from conversation_facts where id=? and character_id=?",
      [Number(body.id), characterId],
    );
    run("delete from conversation_facts where id=? and character_id=?", [Number(body.id), characterId]);
    return { ok: true };
  }
  throw new Error("未知的数字生命操作");
}
