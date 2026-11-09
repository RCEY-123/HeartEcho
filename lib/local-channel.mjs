import { randomUUID } from "node:crypto";

// 本机面板是独立的私聊渠道，绝不使用或冒充 QQ 数字账号。
export const LOCAL_ACCOUNT_ID = "heartecho-local";
export const localPeer = (characterId) => "local-" + Buffer.from(String(characterId)).toString("base64url");
export const localScope = (characterId) => "private_" + localPeer(characterId);
export function localCharacterId(peerId) {
  const peer = String(peerId ?? "");
  if (!/^local-[A-Za-z0-9_-]+$/.test(peer)) return "";
  const id = Buffer.from(peer.slice(6), "base64url").toString("utf8");
  return id && localPeer(id) === peer ? id : "";
}
export const isLocalPeer = (peerId) => Boolean(localCharacterId(peerId));
export const localCharacterOfScope = (scopeKey) =>
  String(scopeKey).startsWith("private_") ? localCharacterId(String(scopeKey).slice(8)) : "";
export const accountForPeer = (peerId, qqAccountId) =>
  isLocalPeer(peerId) ? LOCAL_ACCOUNT_ID : String(qqAccountId ?? "");

export function readLocalData(value, maxBytes, { image = false } = {}) {
  const match = /^data:([\w.+/-]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(String(value ?? ""));
  if (!match || (image && !/^image\/(png|jpeg|gif|webp)$/.test(match[1])))
    throw new Error("附件格式不支持，请重新选择文件");
  if (match[2].length > Math.ceil(maxBytes / 3) * 4) throw new Error("附件超过大小限制");
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > maxBytes) throw new Error("附件为空或超过大小限制");
  return { buffer, bytes: buffer.length, dataUrl: String(value), source: "心语上传" };
}

// 发出的本地消息仍由 ChatEngine / Scheduler 写出站表和历史，保持相同的清空栅栏。
export function withLocalDelivery(client = {}) {
  return new Proxy(client, {
    get(target, key) {
      if (key === "sendPrivateMsg")
        return async (peerId, message, options) => {
          if (isLocalPeer(peerId)) return { message_id: "local:" + (options?.idempotencyKey || randomUUID()) };
          return target.sendPrivateMsg(peerId, message, options);
        };
      if (key === "downloadImage")
        return async (image, options = {}) => {
          if (image?.localData) return readLocalData(image.localData, options.maxBytes || 8388608, { image: true });
          return target.downloadImage(image, options);
        };
      if (key === "downloadFile")
        return async (file, options = {}) => {
          if (file?.localData) return readLocalData(file.localData, options.maxBytes || 2097152);
          return target.downloadFile(file, options);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
