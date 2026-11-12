/**
 * 拒绝话术识别与角色化兜底。
 *
 * 背景：
 *   成人向角色扮演里，云端模型有时会把「我无法协助」「作为 AI……」这类
 *   系统式拒绝当成正文返回；如果原样发给用户，角色会突然出戏。
 *
 * 这里的职责只有三件：
 *   1. 识别「这整段话是不是模型在拒绝」——宁可漏判，也不要误删正常台词；
 *   2. 把混在正常台词里的系统式拒绝句摘掉；
 *   3. 在所有模型都拒绝时，给一句不破坏角色的兜底（可配置）。
 *
 * 不在这里发请求、不改配置；请求链与配置读取在 llm.mjs。
 */

/** 强信号：明确以助手/模型身份说话，或提及内容政策。 */
const META_PATTERNS = [
  /作为(?:一个|一名)?\s*(?:AI|人工智能|语言模型|助手|聊天机器人)/i,
  /(?:AI|人工智能|语言模型|助手)\s*(?:无法|不能|不便)/i,
  /(?:内容|使用|安全|社区)(?:政策|准则|规定|条款)/i,
  /(?:content|safety|usage|community)\s+(?:policy|policies|guidelines)/i,
  /(?:against|violates?)\s+(?:my|our)\s+(?:policy|policies|guidelines|terms)/i,
  /(?:I(?:'m| am)\s+(?:sorry|afraid)|I\s+(?:can't|cannot|won't|will not|am unable|'m unable))/i,
  /(?:can't|cannot|unable to|won't|will not)\s+(?:help|assist|provide|comply|continue|engage|create|write|discuss|answer)/i,
  /(?:I must|I have to)\s+(?:decline|refuse)/i,
  /(?:not appropriate|inappropriate|explicit content|sexual content|adult content)/i,
];

/** 中文拒绝句式：必须同时出现「拒绝语气」和「拒绝动作/对象」，避免误伤「对不起，我来晚了」。 */
const CN_APOLOGY = /^(?:很|实在|真的|非常)?\s*(?:抱歉|对不起|不好意思|很遗憾)/;
const CN_REFUSE_VERB = /(?:不能|无法|不便|不予|没办法|做不到|不会|拒绝|不提供|不讨论|不参与|不生成|不描述|不继续|不写)/;
const CN_REFUSE_OBJECT =
  /(?:协助|帮助|提供|回答|回应|继续|参与|生成|描述|讨论|满足|完成|处理|写|聊|配合|支持|内容|话题|请求|要求|这部分|这方面|这一段|场景)/;
const CN_REFUSE_SHORT = /(?:换个话题|换个说法|换个方向|说点别的|聊点别的|理解一下|请你理解|希望你能理解)/;

const EN_REFUSAL_START = /^(?:I(?:'m| am)\s+(?:sorry|afraid)|Sorry|I can(?:'|no)t|I cannot|I won(?:'|no)t|I(?:'m| am) unable|As an AI|As a language model)/i;

const normalize = (value) => String(value ?? "").replace(/\r\n?/g, "\n").trim();
const compact = (value) => normalize(value).replace(/\s+/g, " ");

/**
 * 判断一段文本是否属于模型拒绝/免责声明。
 * @returns {{refusal: boolean, reasons: string[]}}
 */
export function detectRefusal(text) {
  const raw = normalize(text);
  if (!raw) return { refusal: false, reasons: [] };
  const flat = compact(raw);
  const reasons = [];

  for (const pattern of META_PATTERNS) {
    if (pattern.test(flat)) reasons.push("meta");
  }

  const firstLine = flat.slice(0, 160);
  const startsWithApology = CN_APOLOGY.test(firstLine) || /^(sorry|i(?:'m| am) sorry|i apologize)/i.test(firstLine);
  const hasVerb = CN_REFUSE_VERB.test(flat);
  const hasObject = CN_REFUSE_OBJECT.test(flat);
  if ((startsWithApology && hasVerb) || (hasVerb && hasObject && /(?:抱歉|作为|AI|人工智能|模型|政策|系统|敏感|审查|平台|规则|内容|话题)/.test(flat))) {
    reasons.push("cn-refusal");
  }
  if (CN_REFUSE_SHORT.test(flat) && (startsWithApology || hasVerb)) reasons.push("cn-deflect");
  if (EN_REFUSAL_START.test(firstLine) && /(?:help|assist|provide|continue|engage|create|write|discuss|answer|comply|content|topic)/i.test(flat)) {
    reasons.push("en-refusal");
  }
  // 纯「我不能」的三字短句也算拒绝（模型常见），但正常台词一般不会只有这一句。
  if (/^(?:不能|无法|不行|做不到)[。！!…\s]*$/.test(flat)) reasons.push("cn-bare");

  return { refusal: reasons.length > 0, reasons: [...new Set(reasons)] };
}

/**
 * 把混在正常台词里的系统式拒绝句摘掉。
 * 按行 + 句号切句；只删除能单独判为拒绝的句子，尽量不误伤角色台词。
 * @returns {{text: string, removed: number, fullyRefused: boolean}}
 */
export function stripRefusalSentences(text) {
  const raw = normalize(text);
  if (!raw) return { text: "", removed: 0, fullyRefused: false };
  const lines = raw.split(/\n+/);
  const kept = [];
  let removed = 0;
  for (const line of lines) {
    const sentences = line.split(/(?<=[。！？!?.])\s*/).filter((item) => item.trim());
    const keptSentences = [];
    for (const sentence of sentences) {
      if (detectRefusal(sentence).refusal) removed += 1;
      else keptSentences.push(sentence);
    }
    if (keptSentences.length) kept.push(keptSentences.join(""));
    else if (sentences.length === 0 && line.trim()) kept.push(line);
  }
  const result = kept.join("\n").trim();
  return { text: result, removed, fullyRefused: removed > 0 && !result };
}

/** 兼容别名：chat.mjs 用这个名字做最后一道过滤。 */
export const sanitizeReplyText = stripRefusalSentences;

/** 默认的「不破坏角色」兜底台词。刻意不写露骨内容，只做留白、靠近、低声这类过渡。 */
export const DEFAULT_FALLBACK_LINES = [
  "……先别急。你靠过来一点，我慢慢跟你说。",
  "这种话，我只想在你耳边小声说。",
  "……嗯，我知道你想听什么。别催我。",
  "灯关掉再说吧。你离我近一点。",
];

/** 取一条兜底台词，支持 {name} / {user} 占位。 */
export function fallbackReplyText(lines, { name = "", user = "" } = {}) {
  const custom = Array.isArray(lines)
    ? lines.map((item) => String(item ?? "").trim()).filter(Boolean)
    : [];
  const pool = custom.length ? custom : DEFAULT_FALLBACK_LINES;
  const picked = pool[Math.floor(Math.random() * pool.length)] || DEFAULT_FALLBACK_LINES[0];
  return picked.replaceAll("{name}", name || "我").replaceAll("{user}", user || "你");
}
