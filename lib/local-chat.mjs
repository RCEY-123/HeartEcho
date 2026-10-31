import { getConfig, activeCharacterId, loadCharacter } from "./config.mjs";
import fs from "node:fs";
import path from "node:path";
import { paths } from "./paths.mjs";
import { all, one, run } from "./db.mjs";
import { ensureSession, recentMessages } from "./storage.mjs";
import { scopeGeneration, isCurrentScope } from "./scope-lifecycle.mjs";
import { LOCAL_ACCOUNT_ID, localScope, localPeer, readLocalData } from "./local-channel.mjs";

let recovered = false;
export class LocalChat {
  constructor(chat) {
    this.chat = chat;
    if (!recovered) {
      // 上次被关机中断的模型请求不自动重放，避免重复付费或重复回复。
      run(
        "update local_chat_turns set state = 'interrupted', reason = '上次运行已中断，请重新发送' where state = 'processing'",
      );
      recovered = true;
    }
  }

  history(characterId = activeCharacterId()) {
    const character = loadCharacter(characterId);
    const scopeKey = localScope(character.id);
    return {
      character: { id: character.id, name: character.name },
      scopeKey,
      peerId: localPeer(character.id),
      generation: scopeGeneration(scopeKey),
      messages: recentMessages(scopeKey, 200),
      turns: all(
        "select request_id, state, reason, created_at from local_chat_turns where scope_key = ? and generation = ? order by created_at desc limit 30",
        [scopeKey, scopeGeneration(scopeKey)],
      ),
    };
  }

  async send({ characterId, requestId, generation, text = "", images = [], files = [] } = {}) {
    return this.start({ characterId, requestId, generation, text, images, files }).completion;
  }

  start({ characterId, requestId, generation, text = "", images = [], files = [] } = {}) {
    if (characterId !== activeCharacterId()) throw new Error("当前角色已切换，请刷新后重新发送");
    const character = loadCharacter(characterId);
    const scopeKey = localScope(characterId);
    const peerId = localPeer(characterId);
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(String(requestId ?? ""))) throw new Error("消息编号不合法");
    if (!Number.isSafeInteger(generation) || !isCurrentScope(scopeKey, generation))
      throw new Error("会话已清空，请刷新后重新发送");
    const previous = one("select state, reason from local_chat_turns where scope_key = ? and request_id = ?", [
      scopeKey,
      requestId,
    ]);
    if (previous) {
      const result = {
        scopeKey,
        requestId,
        accepted: true,
        duplicate: true,
        state: previous.state,
        reason: previous.reason,
      };
      return { ...result, completion: Promise.resolve(result) };
    }
    text = String(text).trim();
    if (text.length > 20000) throw new Error("消息过长，请分段发送");
    if (!Array.isArray(images) || !Array.isArray(files) || images.length > 3 || files.length > 3)
      throw new Error("每条消息最多上传三张图片和三个文件");
    if (!text && !images.length && !files.length) throw new Error("请输入消息或选择附件");
    const cfg = getConfig();
    const imageList = images.map((value) => {
      readLocalData(value, Number(cfg.chat.imageMaxBytes) || 8388608, { image: true });
      return { localData: value };
    });
    const fileList = files.map((file) => {
      const got = readLocalData(file?.dataUrl, Number(cfg.chat.files?.maxBytes) || 2097152);
      return { name: String(file.name || "文件").slice(0, 200), size: got.bytes, localData: file.dataUrl };
    });
    if (this.chat.busy.has(scopeKey)) throw new Error("角色正在回复，请稍后再发送");
    if (imageList.length) {
      const dir = path.join(paths.media, "local-images", peerId);
      fs.mkdirSync(dir, { recursive: true });
      for (const [index, image] of imageList.entries()) {
        const format = /^data:image\/([a-z]+);/.exec(image.localData)[1];
        image.file = path.join(dir, requestId + "-" + index + "." + format);
        fs.writeFileSync(
          image.file,
          readLocalData(image.localData, Number(cfg.chat.imageMaxBytes) || 8388608, { image: true }).buffer,
        );
      }
    }
    ensureSession(scopeKey, { characterId, accountId: LOCAL_ACCOUNT_ID, title: character.name + " · 心语对话" });
    run(
      "insert into local_chat_turns(scope_key, request_id, generation, state, created_at) values(?, ?, ?, 'processing', ?)",
      [scopeKey, requestId, generation, Date.now()],
    );
    const eventId = "local:" + peerId + ":" + requestId;
    const completion = this.execute({
      requestId,
      generation,
      text,
      imageList,
      fileList,
      cfg,
      scopeKey,
      peerId,
      eventId,
    });
    // HTTP 客户端离开后仍完成本轮；最终状态始终写入本地 turn，轮询可恢复。
    completion.catch(() => {});
    return { scopeKey, requestId, accepted: true, state: "processing", completion };
  }

  async execute({ requestId, generation, text, imageList, fileList, cfg, scopeKey, peerId, eventId }) {
    try {
      const result = await this.chat.handle({
        platform: "heartecho",
        kind: "private",
        scopeKey,
        scopeGeneration: generation,
        senderId: peerId,
        accountId: LOCAL_ACCOUNT_ID,
        senderName: cfg.bot.masterName || "你",
        eventId,
        messageId: eventId,
        timestampMs: Date.now(),
        text,
        images: imageList,
        files: fileList,
        segments: fileList.map((file) => ({ type: "file", data: { name: file.name } })),
      });
      const current = isCurrentScope(scopeKey, generation);
      const state = !current ? "cancelled" : result.replied ? "done" : "failed";
      const reason = !current ? "会话已清空" : result.reason || (result.replied ? "" : "未生成回复，请检查模型设置");
      run("update local_chat_turns set state = ?, reason = ? where scope_key = ? and request_id = ?", [
        state,
        reason,
        scopeKey,
        requestId,
      ]);
      return { scopeKey, requestId, accepted: true, state, reason, replied: current && result.replied === true };
    } catch (error) {
      run(
        "update local_chat_turns set state = 'failed', reason = ? where scope_key = ? and request_id = ? and state = 'processing'",
        [String(error.message).slice(0, 500), scopeKey, requestId],
      );
      throw error;
    }
  }

  clearScope(scopeKey) {
    run("update local_chat_turns set state = 'cancelled', reason = '' where scope_key = ?", [scopeKey]);
  }
}
