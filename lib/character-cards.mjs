/** Native, shareable JSON cards and explicit per-character removal. */
import fs from "node:fs";
import path from "node:path";
import { paths } from "./paths.mjs";
import { all, one, run, tx } from "./db.mjs";
import { CHARACTER_FIELDS, EMPTY_USER, LOCKABLE_FIELDS, characterPath, listCharacters, loadCharacter, saveCharacter, deleteCharacter, getConfig, saveConfig, activeCharacterId } from "./config.mjs";
import { localPeer, localScope } from "./local-channel.mjs";
import { invalidateCharacter, drainScopeSends, setCharacterRemoval } from "./scope-lifecycle.mjs";
import { clearExtendedScope } from "./extended-memory.mjs";

const TEXT_FIELDS = [...CHARACTER_FIELDS.map(field => field.key).filter(key => key !== "user"), "avatar"];
const MAX_CARD_BYTES = 1024 * 1024;
const removing = new Set();

function sharedCard(source) {
  const card = { id: source.id };
  for (const field of TEXT_FIELDS) {
    if (source[field] !== undefined && typeof source[field] !== "string") throw new Error(`字段 ${field} 必须是文字`);
    card[field] = source[field] || "";
  }
  // A local avatar path belongs to this installation, not to a portable card.
  if (card.avatar && !/^(https?:\/\/|data:image\/(png|jpeg|gif|webp);base64,)/i.test(card.avatar)) card.avatar = "";
  card.user = { ...EMPTY_USER };
  card.userOwnerId = card.userAccountId = "";
  card.localUserEnabled = false;
  if (source.locked !== undefined && (!Array.isArray(source.locked) || source.locked.some(key => !LOCKABLE_FIELDS.includes(key)))) throw new Error("locked 含有不支持的锁定字段");
  card.locked = source.locked || [];
  card.version = Number.isSafeInteger(source.version) && source.version > 0 ? source.version : 1;
  if (typeof source.updatedAt === "string") card.updatedAt = source.updatedAt;
  if (source.cardMetadata && typeof source.cardMetadata === "object" && !Array.isArray(source.cardMetadata)) {
    card.cardMetadata = {};
    for (const key of ["category", "series", "cardVersion", "language", "gameSkinId", "evidenceCommit", "sources", "artReferences", "sampleDialogue"]) {
      if (Object.hasOwn(source.cardMetadata, key)) card.cardMetadata[key] = structuredClone(source.cardMetadata[key]);
    }
  }
  return card;
}

export function parseCharacterCard(content) {
  if (typeof content !== "string" || Buffer.byteLength(content) > MAX_CARD_BYTES) throw new Error("每张角色卡须为不超过 1 MB 的 JSON 文件");
  let source;
  try { source = JSON.parse(content.replace(/^\uFEFF/, "")); } catch { throw new Error("文件不是有效 JSON，请下载角色 JSON 原文件"); }
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("请选择单张原生角色卡 JSON，不是目录索引或配置文件");
  if (typeof source.id !== "string" || !source.id || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(source.id)) throw new Error("角色卡缺少有效 id");
  characterPath(source.id);
  if (typeof source.name !== "string" || !source.name.trim() || typeof source.persona !== "string" || !source.persona.trim()) throw new Error("角色卡必须包含角色名 name 和基础人设 persona");
  return sharedCard(source);
}

export function importCharacterCards(files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 50) throw new Error("每次请选择 1 至 50 张 JSON 角色卡");
  if (Buffer.byteLength(JSON.stringify({ files })) > 12 * 1024 * 1024) throw new Error("本次导入总大小超过 12 MB，请分批导入");
  const results = [];
  for (const file of files) {
    const filename = String(file?.name || "角色卡.json").slice(0, 200);
    try {
      const card = parseCharacterCard(file?.content);
      if (removing.has(card.id)) throw new Error("该角色正在删除，请稍后重试");
      const existing = listCharacters().find(id => id.toLowerCase() === card.id.toLowerCase());
      if (existing) {
        results.push({ filename, id: card.id, name: card.name, status: "skipped", message: "同 ID 角色已存在，已跳过，原卡没有被覆盖" });
        continue;
      }
      const character = saveCharacter(card.id, card, { create: true });
      results.push({ filename, id: character.id, name: character.name, status: "imported", message: "已导入" });
    } catch (error) {
      results.push({ filename, status: "error", message: error.message });
    }
  }
  return { results, imported: results.filter(row => row.status === "imported").length };
}

export function exportCharacterCard(id) {
  return sharedCard(loadCharacter(id));
}

function removeCharacterData(id) {
  const local = localScope(id);
  const scopes = all("select distinct scope_key,account_id from message_origins where character_id=? union select distinct scope_key,account_id from hindsight_records where character_id=?", [id, id]);
  return tx(() => {
    for (const row of scopes) {
      clearExtendedScope(row.scope_key, { alsoMemory: true, characterId: id, accountId: row.account_id });
      run("insert or replace into role_scope_resets values(?,?,?,?)", [id, row.account_id, row.scope_key, Date.now()]);
    }
    // Queue remote erasure above, then remove local content; the queue has no chat text.
    for (const row of all("select id from hindsight_records where character_id=?", [id])) {
      run("delete from meta where key in (?,?)", ["daily-source:" + row.id, "archive-retry:" + row.id]);
    }
    run("delete from hindsight_records where character_id=?", [id]);
    const ownedMessages = "select m.id from messages m left join message_origins o on o.event_key=m.event_key where o.character_id=? or (o.event_key is null and m.scope_key=?)";
    run(`delete from forgotten_fact_sources where message_id in (${ownedMessages})`, [id, local]);
    run(`delete from memory_sources where message_id in (${ownedMessages}) or memory_id in (select id from memories where character_id=?)`, [id, local, id]);
    run("delete from memory_tokens where memory_id in (select id from memories where character_id=?)", [id]);
    run("delete from reflection_owners where reflection_id in (select id from reflections where character_id=?)", [id]);
    run("delete from anniversaries where id in (select birthday_id from birthday_owners where character_id=?)", [id]);
    run(`delete from messages where id in (${ownedMessages})`, [id, local]);
    for (const table of ["memories", "reflections", "goals", "relationships", "life_state", "conversation_evaluations", "conversation_facts", "character_evolution", "evolution_history", "body_profiles", "body_days", "birthday_owners", "memory_grants", "quota_exemptions", "member_policies", "llm_usage"]) {
      run(`delete from ${table} where character_id=?`, [id]);
    }
    run("delete from message_origins where character_id=?", [id]);
    run("delete from characters where id=?", [id]);
    run("delete from blocklist where scope_kind='character' and scope_id=?", [id]);
    // Only local scope-only records have an unambiguous owner; shared QQ jobs stay.
    run("delete from job_runs where job_key in (select job_key from scheduled_jobs where scope_key=?)", [local]);
    for (const table of ["local_chat_turns", "reminders", "outgoing", "scheduled_jobs"]) run(`delete from ${table} where scope_key=?`, [local]);
    for (const scope of new Set([local, ...scopes.map(row => row.scope_key)])) {
      const remaining = one("select count(*) as n from messages where scope_key=?", [scope]).n;
      const owner = one("select character_id,account_id from message_origins where scope_key=? limit 1", [scope]);
      run("update sessions set message_count=?, summary=case when character_id=? then '' else summary end, summary_upto=case when character_id=? then 0 else summary_upto end, archived_upto=case when character_id=? then 0 else archived_upto end, character_id=case when character_id=? then ? else character_id end,qq_account_id=case when character_id=? then ? else qq_account_id end where scope_key=?", [remaining, id, id, id, id, owner?.character_id || "", id, owner?.account_id || "", scope]);
      if (!remaining && scope === local) run("delete from sessions where scope_key=?", [scope]);
    }
    // Retain generation/reset tombstones to prevent stale work and history replay.
  });
}

export async function removeCharacterCard(id, { mode = "keep", confirmation = "" } = {}, { chat } = {}) {
  if (!["keep", "all"].includes(mode)) throw new Error("请选择保留数据或删除该角色数据");
  loadCharacter(id);
  if (confirmation !== id) throw new Error("请确认要删除的角色");
  if (listCharacters().length <= 1) throw new Error("至少要保留一个角色，请先新建或导入其他角色");
  if (removing.has(id)) throw new Error("该角色正在删除，请稍候");
  const original = fs.readFileSync(characterPath(id));
  const originalConfig = getConfig();
  removing.add(id);
  setCharacterRemoval(id, true);
  try {
    invalidateCharacter(id);
    await drainScopeSends("character:" + id);
    chat?.local?.clearScope(localScope(id));
    chat?.scheduler?.clearScope?.(localScope(id));
    try {
      tx(() => {
        if (mode === "all") removeCharacterData(id);
        deleteCharacter(id);
      });
    } catch (error) {
      // Keep the card retryable if database/file/config commit fails.
      if (!fs.existsSync(characterPath(id))) fs.writeFileSync(characterPath(id), original, { flag: "wx" });
      if (getConfig().activeCharacter !== originalConfig.activeCharacter) saveConfig({ activeCharacter: originalConfig.activeCharacter });
      throw error;
    }
    const cleanupWarnings = [];
    if (mode === "all") {
      const peer = localPeer(id);
      const media = path.resolve(paths.media, "local-images", peer);
      if (path.dirname(media) !== path.resolve(paths.media, "local-images")) throw new Error("角色媒体目录无效");
      for (const target of [media, path.join(paths.state, "chat-backgrounds", peer + ".json")]) {
        try { fs.rmSync(target, { recursive: target === media, force: true }); }
        catch { cleanupWarnings.push("角色已删除，但部分本地图片被占用，未能清理"); }
      }
      const cfg = getConfig();
      try { saveConfig({ greet: { proactive: { targets: (cfg.greet?.proactive?.targets || []).filter(item => String(item.userId) !== peer) }, birthdays: { list: (cfg.greet?.birthdays?.list || []).filter(item => String(item.userId) !== peer) } } }); }
      catch { cleanupWarnings.push("角色已删除，但日程目标设置未能更新，请到主动与日程移除旧目标"); }
    }
    return { active: activeCharacterId(), mode, cleanupWarnings, remoteErasurePending: mode === "all" && Boolean(one("select 1 from hindsight_deletions limit 1")) };
  } finally { removing.delete(id); setCharacterRemoval(id, false); }
}
