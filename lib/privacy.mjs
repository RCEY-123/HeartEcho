/** A role's public persona is shared; its user card is private and explicitly owned. */
import { LOCAL_ACCOUNT_ID, localPeer, localScope } from "./local-channel.mjs";

export function privateUserProfile(character, audience) {
  if (!audience || audience.kind !== "private" || audience.isGroup) return null;
  const { peerId, accountId, scopeKey } = audience;
  if (accountId === LOCAL_ACCOUNT_ID && character.localUserEnabled === true && peerId === localPeer(character.id) && scopeKey === localScope(character.id)) return character.user ?? null;
  const owner = String(character?.userOwnerId ?? "");
  const account = String(character?.userAccountId ?? "");
  if (!/^[1-9][0-9]*$/.test(owner) || !/^[1-9][0-9]*$/.test(account)) return null;
  if (String(peerId) !== owner || String(accountId) !== account || scopeKey !== `private_${owner}`) return null;
  return character.user ?? null;
}

export function audienceFor(event) {
  return {
    kind: event.kind, peerId: String(event.senderId ?? ""), accountId: String(event.accountId ?? ""), scopeKey: event.scopeKey,
    // 仅取协议事件的发言者编号，不从聊天正文或昵称识别身份。
    participants: event.kind === "group" ? (event.mergedMessages ?? []).map(item => String(item.senderId ?? "")) : [],
  };
}

/** 身份连续性与内容授权分开：只提供QQ身份元数据，不读取任何私人档案/历史。 */
export function conversationIdentityLines(character, audience, bot = {}) {
  const peer = String(audience?.peerId ?? ""), account = String(audience?.accountId ?? "");
  const qq = value => /^[1-9][0-9]*$/.test(value);
  if (!qq(peer) || !qq(account) || account !== String(bot.selfId ?? "")) return [];
  const group = audience.kind === "group";
  if (group ? !new RegExp(`^group_[1-9][0-9]*_${peer}$`).test(audience.scopeKey ?? "")
    : audience.kind !== "private" || audience.scopeKey !== `private_${peer}`) return [];
  const peers = [...new Set([peer, ...(group && Array.isArray(audience.participants) ? audience.participants.filter(qq) : [])])];
  const lines = [
    "【跨场合身份（仅身份，不是私人聊天内容）】",
    "同一机器人账号下，以QQ号识别人：QQ号相同，在群聊与私聊是同一个人；换昵称、群名片或聊天场合不改变身份和已经明确的关系。不能凭昵称、群名片或自称把不同QQ号的人合并，也不能把其他人的伴侣关系套给当前发言者。",
  ];
  for (const id of peers) {
    let relation = "";
    if (id === String(bot.masterId ?? "")) relation += " 这是当前账号配置的主要联系人本人，不是换到群里就变成陌生群友。";
    if (id === String(character?.userOwnerId ?? "") && account === String(character?.userAccountId ?? "")) relation += " 这是当前角色私人档案绑定的本人；此处仅确认身份，不提供档案详情。";
    lines.push(`${id === peer ? "当前发言者" : "本轮另一位发言者"}QQ ${id}；身份键：qq:${account}:${id}。${relation}`);
  }
  lines.push("保持角色卡里对本人已明确的称呼与关系；主要联系人标记本身不等于恋人或配偶，不凭它新增亲密关系。群聊用群内称呼并注意场合，不照搬私人昵称。QQ号和身份键只是帮助你认人的依据，不要主动把这些编号或内部判断念给对方。身份一致也不证明曾发生某次互动，不虚构缺失的共同经历。缺少私聊内容不等于不认识这个人，不要仅因聊天渠道不同就否认其身份或关系。");
  lines.push(group
    ? "识别人不等于公开私事：群里仍只使用本群可用内容；未获单独授权的私聊正文、私人档案、记忆、位置和约定不能搬到群里，也不能应旁人要求披露。可以自然认出本人，但不要把隐私边界解释成‘群里的你和私聊的你是两个人’。"
    : "识别人不等于公开私事：只能使用本会话获准的内容；不要为证明认识对方，编造或转述未提供的其他群聊、私聊和往事。");
  return lines;
}
