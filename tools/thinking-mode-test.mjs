import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("思考模式传给聊天和测试连接，不支持时不静默移除", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "heartecho-thinking-"));
  for (const key of Object.keys(process.env)) if (key.startsWith("HEARTECHO_")) delete process.env[key];
  Object.assign(process.env, { HEARTECHO_APP_DIR: tmp, HEARTECHO_DATA_DIR: path.join(tmp, "data"), HEARTECHO_LOG_DIR: path.join(tmp, "logs") });
  const originalFetch = globalThis.fetch;
  let db;
  try {
    const { ensureDirs } = await import("../lib/paths.mjs");
    ensureDirs();
    db = await import("../lib/db.mjs");
    db.getDb();
    const { saveConfig } = await import("../lib/config.mjs");
    const { LlmGateway, thinkingParameters } = await import("../lib/llm.mjs");
    for (const [provider, model, format] of [["deepseek", "deepseek-flash", "thinking"], ["zhipu", "glm-4.7", "thinking"], ["moonshot", "kimi-k2.6", "thinking"], ["qwen", "qwen-plus", "enable_thinking"], ["siliconflow", "Qwen/Qwen3", "enable_thinking"], ["ollama", "qwen3.5", "reasoning_effort"], ["openai", "gpt-6-luna", "reasoning_effort"]]) {
      for (const mode of ["enabled", "disabled"]) {
        const result = thinkingParameters({ provider, model, thinkingMode: mode });
        const expected = format === "thinking" ? { thinking: { type: mode } } : format === "enable_thinking" ? { enable_thinking: mode === "enabled" } : { reasoning_effort: mode === "enabled" ? "medium" : "none" };
        assert.deepEqual(result, expected, `${provider} ${mode}`);
      }
    }
    assert.deepEqual(thinkingParameters({ provider: "moonshot", model: "kimi-k3", thinkingMode: "enabled" }), { reasoning_effort: "high" });
    for (const [provider, model] of [["moonshot", "kimi-k3"], ["moonshot", "kimi-k2.7-code-highspeed"], ["zhipu", "glm-5.3-flash"]]) {
      assert.throws(() => thinkingParameters({ provider, model, thinkingMode: "disabled" }), /不支持关闭|不能关闭/);
    }
    assert.deepEqual(thinkingParameters({ provider: "custom", thinkingMode: "disabled", thinkingFormat: "chat_template_kwargs" }), { chat_template_kwargs: { enable_thinking: false } });
    const requests = [];
    let error = false, empty = false;
    globalThis.fetch = async (_url, options) => {
      requests.push(JSON.parse(options.body));
      if (error) return new Response('{"error":"unsupported thinking parameter"}', { status: 400 });
      return Response.json({ choices: [{ message: { role: "assistant", content: empty ? "" : "在的" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 2 } });
    };
    const gateway = new LlmGateway();
    const set = (profile) => saveConfig({ llm: { profiles: { default: { baseUrl: "http://127.0.0.1:1234/v1", apiKey: "SYNTHETIC_ONLY", model: "fixture", ...profile } } } });
    set({ provider: "custom", thinkingMode: "default", thinkingFormat: "auto" });
    const extensionFields = { enable_thinking: false, chat_template_kwargs: { enable_thinking: false, custom_option: "keep" } };
    await gateway.chat([{ role: "user", content: "hello" }], { skipBudget: true, retries: 0, extraBody: extensionFields });
    assert.equal(requests.at(-1).enable_thinking, false);
    assert.deepEqual(requests.at(-1).chat_template_kwargs, extensionFields.chat_template_kwargs);
    assert.equal("reasoning_effort" in requests.at(-1), false);
    empty = true;
    assert.equal((await gateway.testConnection()).ok, true, "默认模式维持原来的空正文连接测试行为");
    empty = false;
    for (const [provider, mode, expected] of [["deepseek", "disabled", { thinking: { type: "disabled" } }], ["qwen", "enabled", { enable_thinking: true }], ["ollama", "disabled", { reasoning_effort: "none" }]]) {
      set({ provider, thinkingMode: mode, thinkingFormat: "auto" });
      await gateway.chat([{ role: "user", content: "hello" }], { skipBudget: true, retries: 0 });
      for (const [key, value] of Object.entries(expected)) assert.deepEqual(requests.at(-1)[key], value);
      assert.equal((await gateway.testConnection()).ok, true);
      for (const [key, value] of Object.entries(expected)) assert.deepEqual(requests.at(-1)[key], value);
    }
    set({ provider: "openai", model: "gpt-6-luna", thinkingMode: "enabled", thinkingFormat: "auto" });
    await gateway.chat([{ role: "user", content: "hello" }], { skipBudget: true, retries: 0 });
    assert.equal(requests.at(-1).reasoning_effort, "medium");
    assert.ok(requests.at(-1).max_completion_tokens > 0);
    assert.equal("max_tokens" in requests.at(-1), false);
    assert.equal("temperature" in requests.at(-1), false);
    assert.equal("top_p" in requests.at(-1), false);
    assert.equal((await gateway.testConnection()).ok, true);
    assert.equal("max_tokens" in requests.at(-1), false);
    assert.equal("temperature" in requests.at(-1), false);
    set({ provider: "ollama", model: "fixture", thinkingMode: "disabled", thinkingFormat: "auto" });
    empty = true;
    assert.equal((await gateway.testConnection()).ok, false);
    empty = false;
    error = true;
    const count = requests.length;
    await assert.rejects(gateway.chat([{ role: "user", content: "hello" }], { skipBudget: true, retries: 0 }), /unsupported thinking parameter/);
    assert.equal(requests.length, count + 1);
    assert.equal(requests.at(-1).reasoning_effort, "none");
    set({ provider: "custom", thinkingMode: "enabled", thinkingFormat: "auto" });
    await assert.rejects(gateway.chat([{ role: "user", content: "hello" }], { skipBudget: true, retries: 0 }), /选择参数格式/);
  } finally {
    globalThis.fetch = originalFetch;
    db?.closeDb();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录可能仍被 Windows 短暂占用。 */ }
  }
});
