/** QQ 状态探测、连接重建与断线续聊；HTTP历史作为事件流异常时的接收兜底。 */
import path from "node:path";
import { createHash } from "node:crypto";
import { getConfig, activeCharacterId } from "./config.mjs";
import { paths, readJson, writeJson } from "./paths.mjs";
import { all, one, run, audit } from "./db.mjs";
import { recoverPrivateFor, recentPrivateScopes } from "./recovery.mjs";
import { normalizeEvent } from "./onebot.mjs";
import { scopeGeneration, scopeState } from "./scope-lifecycle.mjs";
import { createLogger } from "./log.mjs";
import { replyReceiptKey } from "./storage.mjs";

const log = createLogger("QQ恢复");
const hash = text => createHash("sha256").update(text).digest("hex").slice(0, 32);
export class QQRecovery {
  constructor({ client, chat, reconnectTransport, intervalMs = 15000, now = Date.now }) {
    Object.assign(this, { client, chat, reconnectTransport, intervalMs, now });
    this.file = path.join(paths.data, "state", "qq-recovery.json");
    this.saved = readJson(this.file, { accounts: {} });
    if (!this.saved || typeof this.saved !== "object" || Array.isArray(this.saved)) this.saved = {};
    if (!this.saved.accounts || typeof this.saved.accounts !== "object" || Array.isArray(this.saved.accounts)) this.saved.accounts = {};
    this.running = null;
    this.timer = null;
    this.stopped = false;
    this.retryAt = 0;
    this.reconnecting = null;
    this.failures = 0;
    this.onDisconnected = () => this.disconnected();
    this.onConnected = () => { this.tick().catch(e => log.warn(`检查连接失败：${e.message}`)); };
    client.on("disconnected", this.onDisconnected);
    client.on("connected", this.onConnected);
    client.on("account-online", this.onConnected);
  }

  state() {
    const key = `${this.client.selfId}:${activeCharacterId()}`;
    let s = this.saved.accounts[key];
    if (!s || typeof s !== "object" || Array.isArray(s)) s = this.saved.accounts[key] = {};
    for (const field of ["lastHealthyAt", "offlineSince"]) if (!Number.isFinite(s[field]) || s[field] < 0) s[field] = 0;
    if (typeof s.outage !== "string") s.outage = "";
    if (!Array.isArray(s.explained)) s.explained = [];
    if (!s.cursors || typeof s.cursors !== "object" || Array.isArray(s.cursors)) s.cursors = {};
    if (!s.coverage || typeof s.coverage !== "object" || Array.isArray(s.coverage)) s.coverage = {};
    return s;
  }
  persist() { writeJson(this.file, this.saved); }
  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => this.tick().catch(e => log.warn(`恢复检查失败：${e.message}`)), this.intervalMs);
    this.timer.unref?.();
  }
  stop() {
    this.stopped = true; clearInterval(this.timer); this.timer = null;
    this.client.off("disconnected", this.onDisconnected);
    this.client.off("connected", this.onConnected);
    this.client.off("account-online", this.onConnected);
  }
  disconnected() {
    if (this.stopped || this.client.qqPaused || !this.client.selfId) return;
    const s = this.state();
    if (!s.offlineSince) { s.offlineSince = s.lastHealthyAt || this.now(); s.outage = `${s.offlineSince}`; s.explained = []; }
    this.chat.connectionLost?.();
    this.persist();
  }
  reconnect() {
    if (this.reconnecting) return this.reconnecting;
    this.reconnecting = this.manualReconnect().finally(() => { this.reconnecting = null; });
    return this.reconnecting;
  }
  async manualReconnect() {
    this.disconnected();
    this.client.stop();
    // 旧连接代次已经失效；不能等待旧模型/网络请求超时后才允许重连。
    this.running = null;
    await this.reconnectTransport?.({ repair: true });
    if (this.stopped) return { ok: false, message: "心语正在退出" };
    this.client.start();
    this.retryAt = 0;
    return { ok: true, message: "正在重新接入QQ并检查消息通道；登录恢复后会接着回复漏掉的消息" };
  }
  tick() {
    if (this.stopped || this.client.qqPaused || !this.client.selfId) return Promise.resolve();
    if (this.running) return this.running;
    const pending = this.check().finally(() => { if (this.running === pending) this.running = null; });
    this.running = pending;
    return pending;
  }
  async check() {
    if (!this.client.connected) {
      if (this.now() >= this.retryAt) {
        this.retryAt = this.now() + Math.min(60000, 5000 * 2 ** Math.min(this.failures++, 4));
        await this.reconnectTransport?.({ repair: true });
        if (!this.stopped) this.client.start();
      }
      return;
    }
    const generation = this.client.connectionGeneration;
    const accountId = String(this.client.selfId), characterId = activeCharacterId();
    const current = () => !this.stopped && generation === this.client.connectionGeneration && accountId === String(this.client.selfId) && characterId === activeCharacterId();
    let status;
    try {
      status = await this.client.call("get_status", {}, { timeoutMs: 5000 });
      const login = await this.client.call("get_login_info", {}, { timeoutMs: 5000 });
      if (!current()) return;
      if (String(login?.user_id) !== accountId) throw new Error("协议端连接到其他QQ账号，已停止本次恢复");
      this.client.status.nickname = login.nickname || "";
      if (status?.online !== true) throw new Error("QQ尚未重新登录");
    } catch (error) {
      if (!current()) return;
      this.client.setAccountStatus(false, String(error.message));
      if (this.now() >= this.retryAt) {
        this.retryAt = this.now() + 30000;
        await this.reconnectTransport?.({ repair: true });
        // 刷新事件订阅，即使 HTTP / 管理页面仍然可访问也不能继续沿用旧 WS。
        if (!this.stopped) { this.client.stop(); this.client.start(); }
      }
      return;
    }
    const s = this.state();
    const degraded = status?.good === false;
    this.client.status.receiveHealthy = !degraded;
    if (degraded && this.client.status.online) { this.client.setAccountStatus(false, "QQ事件接收异常，正在尝试补收消息"); return; }
    if (!degraded) {
      this.client.setAccountStatus(true);
    }
    this.failures = 0;
    const since = s.offlineSince || s.lastHealthyAt;
    const initial = !since;
    const now = this.now();
    const peers = [...new Set([String(getConfig().bot.masterId || ""), ...recentPrivateScopes(5)])].filter(id => /^[1-9]\d*$/.test(id));
    let errors = false;
    for (const peerId of peers) {
      if (!current()) return;
      const scopeKey = `private_${peerId}`;
      // 实时消息已经由合并器负责，轮询不能给同一批另建补答任务。
      if (this.chat.hasPendingTurn?.(scopeKey)) { errors = true; continue; }
      let cursor = s.cursors[peerId];
      if (cursor?.generation !== scopeGeneration(scopeKey)) cursor = null;
      const covered = s.coverage[peerId];
      const scanSince = covered?.generation === scopeGeneration(scopeKey) && covered.since <= since ? Math.max(since, covered.until) : since;
      let historyFailed = false, more = false;
      // 使用协议端已提供的历史锚点向前翻页；每轮最多三页，下轮继续，避免长时间阻塞重连。
      for (let page = 0; page < 3; page++) {
        const anchor = cursor?.anchor || 0;
        const result = await recoverPrivateFor({ client: this.client, peerId, count: 100, characterId, includeEvents: true, messageId: anchor });
        if (!current()) return;
        if (result.error) { historyFailed = true; break; }
        if (initial) { this.record(result.events || [], characterId, accountId, "done"); break; }
        more = result.fetched >= 100 && result.oldestAt > Math.max(scanSince, scopeState(scopeKey).cleared_at) && result.nextAnchor && String(result.nextAnchor) !== String(anchor);
        if (!more) { delete s.cursors[peerId]; break; }
        cursor = s.cursors[peerId] = { anchor: result.nextAnchor, generation: scopeGeneration(scopeKey) };
      }
      if (initial) { if (historyFailed) errors = true; continue; } // 首次启用仅补存历史。
      if (historyFailed || more) { errors = true; continue; } // 历史未拉齐时先不补答，防止遗漏更早的问题。
      if (this.chat.hasPendingTurn?.(scopeKey)) { errors = true; continue; }
      s.coverage[peerId] = { since, until: now, generation: scopeGeneration(scopeKey) };
      const rows = all(`select m.*,
          exists(select 1 from messages sent join message_origins sent_o on sent_o.event_key = sent.event_key
            where sent.scope_key = m.scope_key and sent.direction = 'out' and sent.at >= m.at
              and sent_o.account_id = o.account_id and sent_o.character_id = o.character_id and sent_o.generation = o.generation) as has_later_reply
        from messages m join message_origins o on o.event_key = m.event_key
        where m.scope_key = ? and m.direction = 'in' and m.at >= ? and m.at <= ?
          and o.account_id = ? and o.character_id = ? and o.generation = ?
        order by m.at, m.id`, [scopeKey, Math.floor(since / 1000) * 1000, now, accountId, characterId, scopeGeneration(scopeKey)]);
      const pending = rows.filter(row => {
        const priorSend = row.platform_message_id && one("select 1 from outgoing where scope_key = ? and idempotency_key like ? and status in ('sent','unknown') limit 1", [scopeKey, `reply:${row.platform_message_id}:%`]);
        if (priorSend) { this.record([{ eventId: row.event_key }], characterId, accountId, "done"); return false; }
        const receipt = one("select value from meta where key = ?", [this.receiptKey(row.event_key, characterId, accountId)]);
        if (!receipt) return !row.has_later_reply;
        const r = JSON.parse(receipt.value);
        if (r.status === "retry" && r.retryAt > now) errors = true;
        return r.status === "retry" && r.retryAt <= now;
      });
      // 先保存整批待答回执，后续批次不能被本批的出站消息误判为已经回答。
      this.record(pending.map(row => ({ eventId: row.event_key })), characterId, accountId, "retry");
      if (pending.length > 40) errors = true;
      const events = pending.slice(0, 40).map(row => ({ ...normalizeEvent({ post_type: "message", message_type: "private", self_id: Number(accountId), user_id: Number(peerId), message_id: row.platform_message_id || row.id, time: row.at / 1000, sender: { user_id: Number(peerId), nickname: row.sender_name }, message: JSON.parse(row.segments_json || "[]") }, accountId),
        eventId: row.event_key, text: row.body, timestampMs: row.at, scopeGeneration: scopeGeneration(scopeKey), expectedCharacter: characterId }));
      if (!events.length && !errors && s.offlineSince && s.lastHealthyAt && scopeState(scopeKey).cleared_at < s.offlineSince && peerId === String(getConfig().bot.masterId) && !s.explained.includes(peerId)) {
        const noticeId = "return-" + hash(`${accountId}:${characterId}:${s.outage}:${peerId}`);
        const previous = one("select status from outgoing where idempotency_key like ? and status in ('sent','unknown') limit 1", [`reply:${noticeId}:%`]);
        if (previous) s.explained.push(peerId);
        else {
          const notice = normalizeEvent({ post_type: "message", message_type: "private", self_id: Number(accountId), user_id: Number(peerId), message_id: noticeId, time: now / 1000, message: [] }, accountId);
          const answer = await this.chat.replyRecovered([notice], { messageId: noticeId, explainAbsence: true, noticeOnly: true });
          if (!current()) return;
          const attempted = one("select status from outgoing where idempotency_key like ? and status in ('sent','unknown') limit 1", [`reply:${noticeId}:%`]);
          if (answer.replied || attempted) s.explained.push(peerId);
          else errors = true;
        }
      }
      if (!events.length) continue;
      // 每条事件落一个持久回执，页面重复重连/应用重启均不会重复补答。
      const jobId = "recovery-" + hash(`${accountId}:${characterId}:${events.map(e => e.eventId).join(",")}`);
      const outgoing = one("select status from outgoing where idempotency_key like ? and status in ('sent','unknown') limit 1", [`reply:${jobId}:%`]);
      if (outgoing) {
        this.record(events, characterId, accountId, "done");
        if (!s.explained.includes(peerId)) s.explained.push(peerId);
        continue;
      }
      this.record(events, characterId, accountId, "retry", now + 30000);
      const answer = await this.chat.replyRecovered(events, { messageId: jobId, explainAbsence: !s.explained.includes(peerId) });
      if (!current()) return;
      const attempted = one("select status from outgoing where idempotency_key like ? and status in ('sent','unknown') limit 1", [`reply:${jobId}:%`]);
      if (answer.replied || attempted) {
        this.record(events, characterId, accountId, "done");
        if (!s.explained.includes(peerId)) s.explained.push(peerId);
        audit({ eventType: "qq_recovery_replied", scopeKey, detail: { count: events.length, uncertain: !answer.replied } });
      } else errors = true;
    }
    if (!current()) return;
    if (!errors) {
      s.lastHealthyAt = now;
      s.offlineSince = 0;
      this.client.status.recovery = degraded ? "history-fallback" : "ready";
    } else this.client.status.recovery = "recovering";
    this.persist();
    if (!degraded && !errors && this.readyGeneration !== generation) {
      this.readyGeneration = generation;
      this.client.emit("account-ready");
    }
    if (degraded && this.now() >= this.retryAt) {
      this.retryAt = this.now() + 60000;
      await this.reconnectTransport?.({ repair: true });
      if (!this.stopped) { this.client.stop(); this.client.start(); }
    }
  }
  receiptKey(eventKey, characterId, accountId) { return replyReceiptKey(eventKey, characterId, accountId); }
  record(events, characterId, accountId, status, retryAt = 0) {
    for (const event of events) run("insert or replace into meta(key,value) values(?,?)", [this.receiptKey(event.eventId, characterId, accountId), JSON.stringify({ status, retryAt })]);
  }
}
