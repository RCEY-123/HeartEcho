import { commitStagedFile } from "./file-commit.mjs";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { paths } from "./paths.mjs";
import { loadCharacter } from "./config.mjs";
import { localPeer, readLocalData } from "./local-channel.mjs";

function metadataFile(characterId) {
  loadCharacter(characterId);
  return path.join(paths.state, "chat-backgrounds", localPeer(characterId) + ".json");
}

export function chatBackground(characterId) {
  try {
    const value = JSON.parse(fs.readFileSync(metadataFile(characterId), "utf8"));
    if (!/^[a-f0-9]{64}\.(png|jpeg|gif|webp)$/.test(value.file)) return null;
    return {
      ...value,
      url: "/api/chat/background/image?characterId=" + encodeURIComponent(characterId) + "&v=" + value.file,
    };
  } catch {
    return null;
  }
}

export function saveChatBackground(characterId, dataUrl) {
  const metadata = metadataFile(characterId);
  if (!dataUrl) {
    fs.rmSync(metadata, { force: true });
    return null;
  }
  const { buffer } = readLocalData(dataUrl, 8 * 1024 * 1024, { image: true });
  const format = /^data:image\/([a-z]+);/.exec(dataUrl)[1];
  const file = createHash("sha256").update(buffer).digest("hex") + "." + format;
  const dir = path.join(paths.media, "chat-backgrounds");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.dirname(metadata), { recursive: true });
  fs.writeFileSync(path.join(dir, file), buffer);
  fs.writeFileSync(metadata + ".tmp", JSON.stringify({ file, mime: "image/" + format }));
  commitStagedFile(metadata + ".tmp", metadata);
  // 图片按内容去重；保留其他角色可能正在使用的文件。
  return chatBackground(characterId);
}

export function readChatBackground(characterId) {
  const background = chatBackground(characterId);
  if (!background) return null;
  try {
    return { ...background, bytes: fs.readFileSync(path.join(paths.media, "chat-backgrounds", background.file)) };
  } catch {
    return null;
  }
}
