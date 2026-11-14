import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { APP_JS } from "../lib/ui-app.mjs";

function composer(reply) {
  const nodes = {
    "#nativeInput": { value: "已经发出的消息" },
    "#nativeLog": { dataset: { character: "fixture" } },
    "#nativeSend": { disabled: false },
    "#nativeFiles": { files: [], value: "" },
    "#nativeFileNames": { textContent: "" },
    "#nativeState": { textContent: "" },
  };
  const drafts = new Map([["he.localDraft.fixture", nodes["#nativeInput"].value]]);
  const context = vm.createContext({
    URLSearchParams,
    crypto,
    setTimeout,
    location: { hash: "", pathname: "/", search: "" },
    window: { addEventListener() {} },
    document: { querySelector: (id) => nodes[id], documentElement: { setAttribute() {} }, addEventListener() {} },
    localStorage: {
      getItem: (key) => drafts.get(key) || null,
      setItem: (key, value) => drafts.set(key, value),
      removeItem: (key) => drafts.delete(key),
    },
    reply,
  });
  vm.runInContext(APP_JS, context);
  vm.runInContext(
    'S.nativeHistory={character:{id:"fixture"},generation:0}; api=reply; refreshNativeChat=async()=>{}; toast=()=>{}',
    context,
  );
  return { nodes, drafts, send: () => vm.runInContext("nativeSend()", context) };
}

test("accepted chat clears the composer before the model finishes", async () => {
  const chat = composer(async () => ({ ok: true, accepted: true, state: "processing" }));
  await chat.send();
  assert.equal(chat.nodes["#nativeInput"].value, "", "发送已被接收后，输入框不应仍保留原消息");
  assert.equal(chat.drafts.has("he.localDraft.fixture"), false);
});

test("rejected messages retain the draft", async () => {
  const chat = composer(async () => ({ ok: false, message: "模型未配置" }));
  await chat.send();
  assert.equal(chat.nodes["#nativeInput"].value, "已经发出的消息");
});

test("a stored message is cleared even if model generation later fails", async () => {
  const chat = composer(async () => ({ ok: true, accepted: true, state: "failed", reason: "模型暂不可用" }));
  await chat.send();
  assert.equal(chat.nodes["#nativeInput"].value, "");
});

test("acceptance never removes text written while the request is in flight", async () => {
  let accept;
  const chat = composer(
    () =>
      new Promise((resolve) => {
        accept = resolve;
      }),
  );
  const sending = chat.send();
  chat.nodes["#nativeInput"].value = "下一条草稿";
  chat.drafts.set("he.localDraft.fixture", "下一条草稿");
  accept({ ok: true, accepted: true, state: "processing" });
  await sending;
  assert.equal(chat.nodes["#nativeInput"].value, "下一条草稿");
  assert.equal(chat.drafts.get("he.localDraft.fixture"), "下一条草稿");
});
