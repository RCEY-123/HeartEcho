import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
const root = process.env.HEARTECHO_TEST_APP_ROOT || path.resolve(import.meta.dirname, "..");
const { cleanReply, splitBubbles } = await import(pathToFileURL(path.join(root, "lib/util.mjs")).href);

const compact = (text) => text.replace(/\s/g, "");
const longReply = "刚才去收被子的时候，闻到上面晒过太阳的味道。".repeat(30) + "今晚也要好好休息。";

for (const enabled of [false, true]) {
  test(`reply remains complete with bubble splitting ${enabled}`, () => {
    const bubbles = splitBubbles(longReply, { enabled, maxChars: 20, maxBubbles: 2 });
    assert.ok(bubbles.length <= 2);
    assert.equal(compact(bubbles.join("")), compact(longReply));
  });
}

test("semantic parentheses, emphasis and emoticons are not swallowed", () => {
  const text = "我（明天一定）会回来。温度是25°C（77°F），记得【带伞】。生日快乐(^_^)。";
  assert.equal(cleanReply(text), text);
  assert.equal(cleanReply("（歪头）**在的哦。**"), "在的哦。");
});

test("numeric model transport markers, including malformed closing brackets, never appear in dialogue", () => {
  const text = "[:: 10000001 ::]不过你握着的时候要轻一点哦，角根那里其实还挺怕痒的呢。[:: 0.20 :]]头上的角今天也热乎乎的，给你握着暖手正好呢。";
  const expected = "不过你握着的时候要轻一点哦，角根那里其实还挺怕痒的呢。头上的角今天也热乎乎的，给你握着暖手正好呢。";
  assert.equal(cleanReply(text), expected);
  assert.equal(cleanReply("[::10000001::][:: 0.20 :]]你好。\n[:: 0.30 ::]明天见。"), "你好。\n明天见。");
  assert.equal(cleanReply("[:: 10000001 ::][:: 0.20 :]]"), "");
  assert.deepEqual(splitBubbles("[:: 0.20 :]]"), []);
  for (const enabled of [true, false]) {
    const bubbles = splitBubbles(text, { enabled, maxChars: 20, maxBubbles: 3 });
    assert.equal(bubbles.join(""), expected);
  }
  assert.equal(cleanReply(expected), expected);
});

test("marker cleanup preserves numeric content, IPv6, citations and ordinary brackets", () => {
  const text = "概率0.20，账号10000001，时间12:06，[1]与[生日礼物]；地址[::1]和[2001:db8::1]，表达式[::正文::]。";
  assert.equal(cleanReply(text), text);
});

test("thought transport marker with a line break does not leak into dialogue", () => {
  const expected = "我已经把小毯子盖在腿上啦，暖呼呼的呢。";
  for (const marker of ["[::thought]::", "[::thought\n]::", "[::thought\r\n]::", "[::thought\\n]::", "[::thought\\r\\n]::", "[::thought\\\n]::", "[::thought\\\r\n]::", "[::thought::]", "[ :: THOUGHT\t] ::"]) {
    const text = marker + expected;
    assert.equal(cleanReply(text), expected, JSON.stringify(marker));
    assert.equal(cleanReply("你好。" + marker + expected), "你好。" + expected);
    assert.equal(cleanReply(marker + marker), "");
    assert.deepEqual(splitBubbles(marker), []);
    for (const enabled of [true, false]) {
      assert.equal(splitBubbles(text, { enabled, maxChars: 20, maxBubbles: 3 }).join(""), expected);
    }
  }
});

test("thought marker cleanup preserves prose and existing reasoning suppression", () => {
  const prose = "I had a thought. [thought] 是普通括号，[::thought experiment]::是示例。正文\\n保留原样；[::正文::]也保留。";
  assert.equal(cleanReply(prose), prose);
  assert.equal(cleanReply("<think>先考虑怎样回答\n内部推理</think>[::thought\n]::我在这里。"), "我在这里。");
  assert.equal(cleanReply("<analysis>内部分析</analysis>[::thought]::我（明天一定）会回来。"), "我（明天一定）会回来。");
  assert.equal(cleanReply("[analysis:内部分析]我在这里。"), "我在这里。");
});

test("bubble boundaries preserve Unicode graphemes and do not insert spaces inside words", () => {
  for (let offset = 0; offset < 22; offset++) {
    const text = "a".repeat(offset) + "👩🏽‍🚀e\u0301".repeat(40) + "结尾。";
    const bubbles = splitBubbles(text, { maxChars: 20, maxBubbles: 8 });
    assert.equal(bubbles.join(""), text);
    const ends = new Set();
    let n = 0;
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) ends.add(n += segment.length);
    n = 0;
    for (const bubble of bubbles) assert.ok(ends.has(n += bubble.length), "must not split an emoji or combining mark");
  }
});
