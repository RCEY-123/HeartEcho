// Actual browser file selection/download and deletion against an isolated app.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const appRoot = process.env.HEARTECHO_TEST_APP_ROOT || root;
const browserPath = ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"].find(file => fs.existsSync(file));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() { const server = net.createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
async function until(fn, label) { for (let i = 0; i < 100; i++) { const value = await fn(); if (value) return value; await delay(100); } throw Error("等待超时：" + label); }
for (const edition of (process.env.HEARTECHO_TEST_EDITION ? [process.env.HEARTECHO_TEST_EDITION] : ["generic", "tb"])) {
  test(`browser cards: ${edition} multi-import, safe download, both deletion choices and slow-response draft isolation`, { timeout: 60000, skip: !browserPath }, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "heartecho-cards-browser-"));
    const data = path.join(tmp, "data"), downloads = path.join(tmp, "downloads"), panelPort = await freePort(), browserPort = await freePort();
    fs.mkdirSync(path.join(data, "characters"), { recursive: true }); fs.mkdirSync(path.join(data, "state"), { recursive: true }); fs.mkdirSync(downloads);
    const card = id => ({ id, name: "合成角色 " + id, persona: "合成基础人设", speechStyle: "自然说话" });
    for (const id of ["first", "second"]) fs.writeFileSync(path.join(data, "characters", id + ".json"), JSON.stringify(card(id)));
    const version = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8")).version;
    fs.writeFileSync(path.join(data, "state", "updates.json"), JSON.stringify({ lastRunVersion: version, acknowledgedVersion: version }));
    fs.writeFileSync(path.join(data, "config.json"), JSON.stringify({ activeCharacter: "first", tb: { initialized: true }, bot: { selfId: 0, masterId: 0, panelPort }, onboarding: { done: true }, weather: { enabled: false }, life: { enabled: false }, chat: { firstDelayMs: 0, antiStall: false, splitBubbles: false, privateMergeWindowSec: 0, followUp: { enabled: false } }, llm: { profiles: { default: { baseUrl: "https://cards.invalid/v1", apiKey: "SYNTHETIC", model: "fixture" } } } }));
    const preload = path.join(tmp, "fixture.mjs");
    fs.writeFileSync(preload, `globalThis.fetch=async url=>{const host=new URL(url).hostname;if(host==='api.github.com')return new Response('[]');if(host==='cards.invalid')return new Response(JSON.stringify({choices:[{message:{content:'合成回复'},finish_reason:'stop'}],usage:{prompt_tokens:3,completion_tokens:3}}));throw new Error('external network blocked in test')};`);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HEARTECHO_") && !["NODE_OPTIONS", "NODE_TEST_CONTEXT"].includes(key)));
    Object.assign(env, { HEARTECHO_APP_DIR: appRoot, HEARTECHO_DATA_DIR: data, HEARTECHO_EDITION: edition, HEARTECHO_SETTINGS: path.join(tmp, "settings.json"), HEARTECHO_LOG_DIR: path.join(tmp, "logs"), HEARTECHO_SNOWLUMA_DIR: path.join(tmp, "no-protocol"), HEARTECHO_CLAIM_DIR: path.join(tmp, "claims"), HEARTECHO_INSTANCES_HOME: path.join(tmp, "instances"), LOCALAPPDATA: path.join(tmp, "local"), HEARTECHO_LOG_LEVEL: "error" });
    if (process.env.HEARTECHO_TEST_APP_ROOT) Object.assign(env, { HEARTECHO_INSTALLED: "1", HEARTECHO_INSTALL_ROOT: path.dirname(appRoot) });
    const app = spawn(process.execPath, ["--import", pathToFileURL(preload).href, "index.mjs", "--no-panel", "--no-tray", "--no-autostart"], { cwd: appRoot, env, windowsHide: true, stdio: "pipe" });
    let output = ""; app.stdout.on("data", chunk => { output += chunk; }); app.stderr.on("data", chunk => { output += chunk; });
    const browser = spawn(browserPath, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${path.join(tmp, "browser")}`, `--remote-debugging-port=${browserPort}`, "--window-size=1280,1080", "about:blank"], { stdio: "ignore", windowsHide: true });
    let ws, sequence = 0; const pending = new Map(), errors = [];
    try {
      await until(async () => { try { return (await fetch(`http://127.0.0.1:${panelPort}/`)).ok; } catch { if (app.exitCode !== null) throw Error(output); return false; } }, "应用启动");
      const targets = await until(async () => { try { return (await fetch(`http://127.0.0.1:${browserPort}/json/list`)).json(); } catch { return false; } }, "浏览器启动");
      ws = new WebSocket(targets.find(target => target.type === "page").webSocketDebuggerUrl);
      await new Promise((resolve, reject) => { ws.addEventListener("open", resolve); ws.addEventListener("error", reject); });
      ws.addEventListener("message", event => { const message = JSON.parse(String(event.data)); if (message.id && pending.has(message.id)) { const task = pending.get(message.id); pending.delete(message.id); clearTimeout(task.timer); if (message.error) task.reject(Error(message.error.message)); else task.resolve(message.result); } else if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text); });
      const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(Error("CDP timeout " + method)); }, 12000); pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params })); });
      const evaluate = async expression => { const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result?.value; };
      await cdp("Runtime.enable"); await cdp("Page.enable"); await cdp("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
      const token = fs.readFileSync(path.join(data, "panel-token"), "utf8").trim();
      await cdp("Page.navigate", { url: `http://127.0.0.1:${panelPort}/#panelToken=${token}` });
      await until(() => evaluate('Boolean(document.querySelector("#btnSandboxJump"))'), "总览");
      await evaluate('go("studio")'); await until(() => evaluate('Boolean(document.querySelector("#characterCardImport"))'), "角色工作室");
      const upload = async files => { const document = await cdp("DOM.getDocument"); const input = await cdp("DOM.querySelector", { nodeId: document.root.nodeId, selector: "#characterCardFileInput" }); await cdp("DOM.setFileInputFiles", { nodeId: input.nodeId, files }); };
      const importedFile = path.join(tmp, "imported.json"), invalidFile = path.join(tmp, "index.json");
      fs.writeFileSync(importedFile, JSON.stringify({ ...card("imported"), user: { notes: "PRIVATE_IMPORT" }, userOwnerId: "10000002", localUserEnabled: true, cardMetadata: { category: "角色卡", series: "合成来源" } })); fs.writeFileSync(invalidFile, JSON.stringify({ cards: [] }));
      await evaluate('document.querySelector("#ch_persona").value="未保存草稿"');
      await upload([importedFile, invalidFile]);
      await until(() => evaluate('document.querySelector("#modal").innerText.includes("角色卡导入结果")'), "多选导入结果");
      assert.match(await evaluate('document.querySelector("#modal").innerText'), /已导入 1 张/);
      assert.equal(await evaluate('document.querySelector("#ch_persona").value'), "未保存草稿");
      assert.equal(await evaluate('S.editingCharacter.id'), "first");
      await evaluate('document.querySelector("#modalClose").click(); document.querySelector("[data-char=imported]").click()');
      await until(() => evaluate('S.editingCharacter?.id === "imported" && document.querySelector("#ch_name").value.includes("imported")'), "选中导入角色");
      await evaluate('document.querySelector("#characterCardExport").click()');
      await until(() => fs.existsSync(path.join(downloads, "imported.json")), "实际浏览器下载");
      const exported = JSON.parse(fs.readFileSync(path.join(downloads, "imported.json"), "utf8")); assert.equal(exported.persona, "合成基础人设"); assert.doesNotMatch(JSON.stringify(exported), /PRIVATE_IMPORT|10000002/); assert.equal(exported.cardMetadata.series, "合成来源");
      await evaluate('document.querySelector("#btnActivateChar").click()'); await until(() => evaluate('S.activeCharacter?.id === "imported"'), "启用导入角色");
      await evaluate('go("chat")'); await until(() => evaluate('Boolean(document.querySelector("#nativeInput")) && S.nativeHistory?.character?.id === "imported"'), "聊天页与角色历史就绪");
      await evaluate('document.querySelector("#nativeInput").value="合成聊天记录"; document.querySelector("#nativeSend").click()');
      await until(() => evaluate('document.querySelector("#nativeLog").innerText.includes("合成回复")'), "隔离模型回复");
      await evaluate('go("studio")'); await until(() => evaluate('Boolean(document.querySelector("#characterCardDelete"))'), "返回工作室");
      await evaluate('document.querySelector("#characterCardDelete").click()');
      assert.equal(await evaluate('document.querySelector("input[name=characterDeleteMode]:checked").value'), "keep");
      await evaluate('document.querySelector("#modalClose").click()'); assert.ok(fs.existsSync(path.join(data, "characters", "imported.json")));
      await evaluate('document.querySelector("#characterCardDelete").click(); document.querySelector("#characterCardDeleteConfirm").click()');
      await until(() => !fs.existsSync(path.join(data, "characters", "imported.json")), "保留数据删除");
      await until(() => evaluate('!S.busy.characterDelete'), "删除UI刷新");
      await upload([importedFile]); await until(() => evaluate('document.querySelector("#modal").innerText.includes("角色卡导入结果")'), "重新导入");
      await evaluate('document.querySelector("#modalClose").click(); document.querySelector("[data-char=imported]").click()'); await until(() => evaluate('S.editingCharacter.id === "imported"'), "重新选择");
      assert.equal(await evaluate('api("/api/chat/local?characterId=imported").then(result=>result.messages.length)'), 2);
      await evaluate('document.querySelector("#characterCardDelete").click(); document.querySelector("input[name=characterDeleteMode][value=all]").checked=true');
      await until(() => evaluate('Number(getComputedStyle(document.querySelector("#modal .modal-back")).opacity) >= 0.99'), "删除确认弹窗动画完成");
      const shots = path.join(root, "build", "dev18-cards-qa"); fs.mkdirSync(shots, { recursive: true });
      const shot = await cdp("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(shots, edition + "-delete-options.png"), Buffer.from(shot.data, "base64"));
      await evaluate('document.querySelector("#characterCardDeleteConfirm").click()'); await until(() => evaluate('!S.busy.characterDelete'), "清理数据删除");
      await upload([importedFile]); await until(() => evaluate('document.querySelector("#modal").innerText.includes("角色卡导入结果")'), "清数据后重导");
      assert.equal(await evaluate('api("/api/chat/local?characterId=imported").then(result=>result.messages.length)'), 0);
      await evaluate('document.querySelector("#modalClose").click()');
      const slow = path.join(tmp, "slow.json"); fs.writeFileSync(slow, JSON.stringify(card("slow")));
      await evaluate('window.originalCardFetch=window.fetch; window.fetch=async function(url,opts){const result=await originalCardFetch(url,opts); if(String(url)==="/api/characters/import") await new Promise(resolve=>window.releaseCardImport=resolve); return result;}');
      await upload([slow]); await until(() => evaluate('Boolean(window.releaseCardImport)'), "慢导入已等待");
      await evaluate('document.querySelector("[data-char=second]").click()'); await until(() => evaluate('S.editingCharacter.id === "second" && document.querySelector("#ch_name").value.includes("second")'), "导入中切换编辑角色");
      await evaluate('document.querySelector("#ch_persona").value="后来输入的草稿"; window.releaseCardImport(); window.fetch=window.originalCardFetch');
      await until(() => evaluate('!S.busy.characterImport'), "慢导入完成");
      assert.equal(await evaluate('S.editingCharacter.id'), "second"); assert.equal(await evaluate('document.querySelector("#ch_persona").value'), "后来输入的草稿");
      await evaluate('document.querySelector("#modalClose").click()');
      const oldTime = await evaluate('performance.timeOrigin'); await cdp("Page.reload"); await until(() => evaluate(`performance.timeOrigin !== ${oldTime} && typeof S !== "undefined" && Boolean(S.activeCharacter)`), "重载真实持久状态");
      assert.equal(await evaluate('api("/api/characters").then(r=>r.list.some(c=>c.id==="slow"))'), true);
      assert.deepEqual(errors, []);
    } finally {
      for (const task of pending.values()) clearTimeout(task.timer); ws?.close();
      for (const child of [app, browser]) if (child.exitCode === null) { child.kill(); await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(3000)]); }
      assert.equal(path.dirname(tmp), os.tmpdir()); assert.ok(path.basename(tmp).startsWith("heartecho-cards-browser-")); fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
}
