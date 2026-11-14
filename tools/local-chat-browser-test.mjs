// 独立数据目录 + 本机模拟模型 + 无头 Edge/Chrome，验证用户实际点击的聊天流程。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = fileURLToPath(new URL("..", import.meta.url));
const appRoot = process.env.HEARTECHO_TEST_APP_ROOT || root;
const browserPath = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].find((name) => fs.existsSync(name));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function until(fn, label) {
  for (let i = 0; i < 100; i++) {
    const result = await fn();
    if (result) return result;
    await delay(100);
  }
  throw new Error("等待超时：" + label);
}

test(
  "browser: direct chat, persistent draft/history, role isolation, memory, life and proactive delivery without QQ",
  { timeout: 90000, skip: !browserPath },
  async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "heartecho-local-browser-"));
    const data = path.join(tmp, "data");
    const browserPort = await freePort(),
      panelPort = await freePort();
    const modelCalls = [];
    const modelLists = [];
    let rejectModelList = false;
    let modelGate = null;
    const model = http.createServer(async (req, res) => {
      if (req.method === "GET" && /\/models$/.test(req.url)) {
        const slot = req.url.includes("fallback2") ? "fallback2" : "fallback1";
        modelLists.push({ slot, authorization: req.headers.authorization });
        res.writeHead(rejectModelList ? 401 : 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(rejectModelList ? { error: "synthetic unauthorized" } : { data: [{ id: slot + "-fast" }, { id: slot + "-chat" }] }));
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      modelCalls.push(body);
      if (modelGate) await modelGate;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "fixture",
          choices: [
            {
              message: {
                role: "assistant",
                content: body.messages.some((m) => m.content.includes("今天第一次打开心语"))
                  ? "指挥官，你来啦！测试港今天预报中雨，12到19度，出门记得带伞。"
                  : body.messages.some((m) => m.role === "system" && m.content.includes("写一条‘她的日常’"))
                  ? JSON.stringify({ text: "我独自翻了几页书，又整理好散乱的笔记，心里也慢慢安静下来。", participants: [] })
                  : body.messages.some((m) => m.role === "system" && m.content.includes("核对角色独处日常"))
                  ? JSON.stringify({ allowed: true, solo: true, consistent: true, noNewRelationship: true })
                  : body.messages.some((m) => m.role === "system" && m.content.includes("将单个会话当天"))
                  ? JSON.stringify({ summary: "她记住了明天与对方一起看海的约定，心里有些期待。", experiences: [{ text: "我把明天和你一起看海的约定放在心里，已经开始偷偷期待了。", sourceMessageId: Number(body.messages.map(m => m.content).join("\n").match(/消息#(\d+)/)?.[1]) }] })
                  : "[:: 10000001 ::][::thought\n]::记得呀，[:: 0.20 :]][::thought\\n]::我们明天一起去看海。",
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 12 },
        }),
      );
    });
    await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
    fs.mkdirSync(path.join(data, "characters"), { recursive: true });
    fs.mkdirSync(path.join(data, "state"), { recursive: true });
    const version = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8")).version;
    fs.writeFileSync(
      path.join(data, "state", "update-install.json"),
      JSON.stringify({ fromVersion: "1.3.0-dev.1", version }),
    );
    const githubMode = path.join(tmp, "github-mode.txt");
    fs.writeFileSync(githubMode, "offline");
    const networkFixture = path.join(tmp, "github-fixture.mjs");
    fs.writeFileSync(
      networkFixture,
      `import fs from 'node:fs'; import {createHash} from 'node:crypto';
const modeFile=${JSON.stringify(githubMode)};
const actualFetch=globalThis.fetch;
const bytes=Buffer.from('browser fixture installer: never execute');
const hash=createHash('sha256').update(bytes).digest('hex');
const version='1.3.0-dev.99';
const assets=['心语','领航员终端'].flatMap(title=>{const name=title+'-'+version+'-安装.exe';const url='https://github.com/RCEY-123/HeartEcho/releases/download/v'+version+'/';return [{name,size:bytes.length,browser_download_url:url+encodeURIComponent(name)},{name:name+'.sha256',size:100,browser_download_url:url+encodeURIComponent(name+'.sha256')}];});
globalThis.fetch=async (url,options)=>{
 const address=String(url);
 if(address.startsWith('https://api.github.com/'))return fs.readFileSync(modeFile,'utf8')==='offline'?new Response('',{status:503}):new Response(JSON.stringify([{tag_name:'v'+version,prerelease:true,body:'更新说明 <script>不会执行</script>',assets}]));
 if(address.startsWith('https://github.com/RCEY-123/HeartEcho/releases/download/')) {const name=decodeURIComponent(new URL(address).pathname.split('/').at(-1));return name.endsWith('.sha256')?new Response(hash+'  '+name.slice(0,-7)):new Response(bytes);}
 if(new URL(address).hostname==='geocoding-api.open-meteo.com')return new Response(JSON.stringify({results:[{name:'测试港',latitude:30,longitude:120,timezone:'Asia/Shanghai'}]}));
 if(new URL(address).hostname==='api.open-meteo.com')return new Response(JSON.stringify({daily:{time:[new Date().toLocaleDateString('en-CA')],weather_code:[63],temperature_2m_min:[12],temperature_2m_max:[19],precipitation_probability_max:[90],wind_speed_10m_max:[20]}}));
 if(new URL(address).hostname!=='127.0.0.1')throw new Error('test blocked external network');
 return actualFetch(url,options);
};`,
    );
    for (const [id, name] of [
      ["first", "小语"],
      ["second", "小星"],
    ])
      fs.writeFileSync(
        path.join(data, "characters", id + ".json"),
        JSON.stringify({ id, name, persona: "陪伴朋友的角色" }),
      );
    fs.writeFileSync(
      path.join(data, "config.json"),
      JSON.stringify({
        activeCharacter: "first",
        tb: { initialized: true },
        bot: { selfId: 0, masterId: 0, panelPort },
        onboarding: { done: false },
        weather: { enabled: false },
        chat: { firstDelayMs: 0, antiStall: false, splitBubbles: false, followUp: { enabled: false } },
        llm: {
          profiles: {
            default: {
              provider: "custom",
              baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
              apiKey: "mock-browser",
              model: "fixture",
            },
          },
        },
      }),
    );
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HEARTECHO_")));
    Object.assign(env, {
      HEARTECHO_APP_DIR: appRoot,
      HEARTECHO_DATA_DIR: data,
      HEARTECHO_SETTINGS: path.join(tmp, "settings.json"),
      HEARTECHO_LOG_DIR: path.join(tmp, "logs"),
      HEARTECHO_SNOWLUMA_DIR: path.join(tmp, "no-protocol"),
      HEARTECHO_CLAIM_DIR: path.join(tmp, "claims"),
      HEARTECHO_INSTANCES_HOME: path.join(tmp, "instances"),
      LOCALAPPDATA: path.join(tmp, "local"),
      HEARTECHO_LOG_LEVEL: "error",
    });
    if (process.env.HEARTECHO_TEST_APP_ROOT)
      Object.assign(env, {
        HEARTECHO_INSTALLED: "1",
        HEARTECHO_INSTALL_ROOT: path.dirname(appRoot),
        HEARTECHO_EDITION: process.env.HEARTECHO_TEST_EDITION || "tb",
      });
    const app = spawn(
      process.execPath,
      ["--import", pathToFileURL(networkFixture).href, "index.mjs", "--no-panel", "--no-tray", "--no-autostart"],
      {
        cwd: appRoot,
        env,
        stdio: "pipe",
        windowsHide: true,
      },
    );
    let appOutput = "";
    app.stdout.on("data", (chunk) => {
      appOutput += chunk;
    });
    app.stderr.on("data", (chunk) => {
      appOutput += chunk;
    });
    const browser = spawn(
      browserPath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${path.join(tmp, "browser")}`,
        `--remote-debugging-port=${browserPort}`,
        "--window-size=1280,1080",
        "about:blank",
      ],
      { stdio: "ignore", windowsHide: true },
    );
    let ws;
    const pending = new Map();
    const errors = [];
    let sequence = 0;
    try {
      await until(async () => {
        try {
          return (await fetch(`http://127.0.0.1:${panelPort}/`)).ok;
        } catch {
          if (app.exitCode !== null) throw new Error(appOutput);
          return false;
        }
      }, "独立服务启动");
      const targets = await until(async () => {
        try {
          return (await fetch(`http://127.0.0.1:${browserPort}/json/list`)).json();
        } catch {
          return false;
        }
      }, "浏览器启动");
      ws = new WebSocket(targets.find((item) => item.type === "page").webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve);
        ws.addEventListener("error", reject);
      });
      ws.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data));
        if (message.id && pending.has(message.id)) {
          const task = pending.get(message.id);
          pending.delete(message.id);
          clearTimeout(task.timer);
          if (message.error) task.reject(new Error(message.error.message));
          else task.resolve(message.result);
        } else if (message.method === "Runtime.exceptionThrown")
          errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      });
      const cdp = (method, params = {}) =>
        new Promise((resolve, reject) => {
          const id = ++sequence;
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error("CDP timeout " + method));
          }, 12000);
          pending.set(id, { resolve, reject, timer });
          ws.send(JSON.stringify({ id, method, params }));
        });
      const evaluate = async (expression) => {
        const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails)
          throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        return result.result?.value;
      };
      await cdp("Runtime.enable");
      await cdp("Page.enable");
      const token = fs.readFileSync(path.join(data, "panel-token"), "utf8").trim();
      await cdp("Page.navigate", { url: `http://127.0.0.1:${panelPort}/#panelToken=${token}` });
      await until(() => evaluate('Boolean(document.querySelector("#btnSandboxJump"))'), "总览");
      assert.equal(await evaluate('Boolean(document.querySelector("#btnFixProtocol"))'), false);
      await until(() => evaluate('Boolean(document.querySelector("#wzNext"))'), "首次向导");
      assert.equal(await evaluate('Boolean(document.querySelector("#wz_self"))'), false);
      await evaluate('document.querySelector("#wzNext").click()');
      await until(() => evaluate('Boolean(document.querySelector("#wz_privacy"))'), "隐私说明");
      assert.equal(await evaluate('Boolean(document.querySelector("#wz_master"))'), false);
      await evaluate('document.querySelector("#wzNext").click()');
      await until(() => evaluate('Boolean(S.nativeHistory && document.querySelector("#nativeInput"))'), "原生聊天");
      await until(
        () =>
          evaluate(
            'Boolean(document.querySelector("#modal h3") && document.querySelector("#modal h3").innerText.includes("已更新到"))',
          ),
        "安装后更新说明",
      );
      const { releaseNotes } = await import(pathToFileURL(path.join(appRoot, "lib", "release-notes.mjs")).href);
      assert.ok(await evaluate(`document.querySelector("#modal").innerText.includes(${JSON.stringify(releaseNotes.title)})`));
      await evaluate('document.querySelector("#modalClose").click()');
      await evaluate('go("llm")');
      await until(() => evaluate('Boolean(document.querySelector("#btnSaveAdult"))'), "备用接口设置页");
      await evaluate('document.querySelector("#llm_base").value="https://draft.invalid/v1"; document.querySelector("#fb_lines").value="保留未保存的兜底台词"');
      for (const slot of ["fallback1", "fallback2"]) {
        assert.ok(await evaluate(`Boolean(document.querySelector("#${slot}_fetch"))`), "备用接口必须提供模型列表读取入口");
        const address = `http://127.0.0.1:${model.address().port}/${slot}/v1`;
        await evaluate(`document.querySelector("#${slot}_base").value=${JSON.stringify(address)}; document.querySelector("#${slot}_key").value="mock-${slot}"; document.querySelector("#${slot}_fetch").click()`);
        await until(() => evaluate(`Array.from(document.querySelector("#${slot}_model").options).some(o=>o.value==="${slot}-fast")`), "获取备用接口模型列表");
        assert.equal(modelLists.at(-1).slot, slot);
        assert.equal(modelLists.at(-1).authorization, "Bearer mock-" + slot);
        await evaluate(`document.querySelector("#${slot}_model").value="${slot}-fast"; document.querySelector("#${slot}_enabled").checked=true`);
      }
      assert.equal(await evaluate('document.querySelector("#llm_base").value'), "https://draft.invalid/v1");
      assert.equal(await evaluate('document.querySelector("#fb_lines").value'), "保留未保存的兜底台词");
      assert.equal(JSON.parse(fs.readFileSync(path.join(data, "config.json"))).llm.profiles.fallback1, undefined, "读取列表不能保存未提交配置");
      await evaluate('document.querySelector("#btnSaveAdult").click()');
      await until(() => evaluate('Boolean(document.querySelector("#fallback1_fetch") && document.querySelector("#fallback1_key").placeholder.includes("已保存"))'), "保存备用配置");
      const savedFallbacks = JSON.parse(fs.readFileSync(path.join(data, "config.json"))).llm;
      assert.equal(savedFallbacks.profiles.default.model, "fixture");
      assert.equal(savedFallbacks.profiles.fallback1.model, "fallback1-fast");
      assert.equal(savedFallbacks.profiles.fallback2.model, "fallback2-fast");
      assert.deepEqual(savedFallbacks.refusalFallback.profileIds, ["fallback1", "fallback2"]);
      const listCount = modelLists.length;
      await evaluate('document.querySelector("#fallback1_fetch").click()');
      await until(async () => (await evaluate('!document.querySelector("#fallback1_fetch").disabled')) && modelLists.length > listCount, "使用已保存Key读取备用模型列表");
      assert.equal(modelLists.at(-1).authorization, "Bearer mock-fallback1");
      rejectModelList = true;
      await evaluate('document.querySelector("#fallback1_fetch").click()');
      await until(() => evaluate('document.querySelector("#fallback1_models_status").textContent.includes("失败")'), "读取失败提示");
      await evaluate('document.querySelector("#fallback1_model").value="__manual__"; document.querySelector("#fallback1_model").dispatchEvent(new Event("change")); document.querySelector("#fallback1_model_manual").value="custom-fallback-model"; document.querySelector("#btnSaveAdult").click()');
      await until(() => evaluate('document.querySelector("#fallback1_model")?.value === "custom-fallback-model"'), "失败后仍可手动填写并保存模型");
      assert.equal(JSON.parse(fs.readFileSync(path.join(data, "config.json"))).llm.profiles.fallback1.model, "custom-fallback-model");
      rejectModelList = false;
      await evaluate('go("chat")');
      await until(() => evaluate('Boolean(document.querySelector("#nativeInput"))'), "返回角色对话");
      await evaluate(
        'document.querySelector("#nativeInput").value="记住：我喜欢看海"; document.querySelector("#nativeSend").click()',
      );
      await until(() => evaluate('document.querySelector("#nativeLog").innerText.includes("记下")'), "快捷记忆");
      assert.equal(await evaluate('document.querySelector("#nativeInput").value'), "");
      let releaseModel;
      modelGate = new Promise((resolve) => {
        releaseModel = resolve;
      });
      const burst = ["明天别忘了陪我去看海", "下午我有空", "今天先整理照片", "所以我们明天再出发"];
      for (const text of burst) {
        await until(() => evaluate('!document.querySelector("#nativeSend").disabled'), "等待提交完成后可以继续补充");
        await evaluate(
          'document.querySelector("#nativeInput").value=' +
            JSON.stringify(text) +
            '; document.querySelector("#nativeSend").click()',
        );
        await until(() => evaluate('document.querySelector("#nativeInput").value === ""'), "接收消息后及时清空输入框");
      }
      assert.equal(modelCalls.length, 0, "说完前不逐条请求模型");
      await until(() => modelCalls.length === 1, "合并等待结束后开始统一生成");
      assert.equal(modelCalls.length, 1);
      const combined = modelCalls[0].messages
        .filter((m) => m.role === "user")
        .map((m) => m.content)
        .join("\n");
      for (const part of burst) assert.equal(combined.split(part).length - 1, 1, "本轮消息只出现一次");
      releaseModel();
      modelGate = null;
      await until(
        () => evaluate('document.querySelector("#nativeLog").innerText.includes("我们明天一起去看海")'),
        "模型回复",
      );
      assert.ok(JSON.stringify(modelCalls).includes("我喜欢看海"));
      assert.doesNotMatch(await evaluate('document.querySelector("#nativeLog").innerText'), /\[\s*::|:\]\]/);
      const historyScope = await evaluate("S.nativeHistory.scopeKey");
      const fixtureDb = new DatabaseSync(path.join(data, "database", "main.db"));
      const session = fixtureDb.prepare("select id from sessions where scope_key = ?").get(historyScope);
      const insert = fixtureDb.prepare(
        "insert into messages(event_key,session_id,scope_key,direction,sender_name,kind,at,body,created_at) values(?,?,?,'in','Fixture','private',?,?,?)",
      );
      const oldAt = Date.now() - 86400000;
      for (let n = 0; n < 230; n++)
        insert.run(`browser-older-${n}`, session.id, historyScope, oldAt + n, `history-marker-${n};`, oldAt);
      fixtureDb.prepare("update sessions set message_count = message_count + 230 where id = ?").run(session.id);
      fixtureDb.close();
      await evaluate("refreshNativeChat()");
      assert.equal(
        await evaluate('document.querySelector("#nativeLog").innerText.includes("history-marker-0;")'),
        false,
      );
      await until(() => evaluate('Boolean(document.querySelector("#nativeOlder") && !document.querySelector("#nativeOlder").disabled)'), "历史分页按钮读取就绪");
      await evaluate('document.querySelector("#nativeOlder").click()');
      await until(
        () => evaluate('document.querySelector("#nativeLog").innerText.includes("history-marker-0;")'),
        "原生对话翻看超过200条的历史",
      );
      await evaluate("refreshNativeChat()");
      assert.equal(
        await evaluate('document.querySelector("#nativeLog").innerText.includes("history-marker-0;")'),
        true,
      );
      const background = path.join(tmp, "聊天背景.png");
      fs.writeFileSync(
        background,
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=",
          "base64",
        ),
      );
      const dom = await cdp("DOM.getDocument");
      const fileInput = await cdp("DOM.querySelector", { nodeId: dom.root.nodeId, selector: "#nativeBackground" });
      await cdp("DOM.setFileInputFiles", { nodeId: fileInput.nodeId, files: [background] });
      await until(
        () =>
          evaluate('document.querySelector("#nativeLog").style.backgroundImage.includes("/api/chat/background/image")'),
        "导入自定义背景",
      );
      await evaluate(
        'document.querySelector("#nativeInput").value="尚未发送的草稿"; document.querySelector("#nativeInput").dispatchEvent(new Event("input"))',
      );
      await cdp("Page.reload");
      await until(() => evaluate('Boolean(document.querySelector("#nativeInput") && S.nativeHistory)'), "刷新恢复");
      assert.equal(await evaluate('document.querySelector("#nativeInput").value'), "尚未发送的草稿");
      assert.ok(
        await evaluate(
          'document.querySelector("#nativeLog").style.backgroundImage.includes("/api/chat/background/image")',
        ),
      );
      await evaluate(
        'document.querySelector("#nativeCharacter").value="second"; document.querySelector("#nativeCharacter").dispatchEvent(new Event("change"))',
      );
      await until(() => evaluate('Boolean(S.nativeHistory && S.nativeHistory.character.id === "second")'), "切换角色");
      assert.ok(!(await evaluate('document.querySelector("#nativeLog").innerText.includes("我喜欢看海")')));
      assert.equal(await evaluate('document.querySelector("#nativeInput").value'), "");
      assert.equal(await evaluate('document.querySelector("#nativeLog").style.backgroundImage'), "");
      await evaluate(
        'document.querySelector("#nativeCharacter").value="first"; document.querySelector("#nativeCharacter").dispatchEvent(new Event("change"))',
      );
      await until(() => evaluate('Boolean(S.nativeHistory && S.nativeHistory.character.id === "first")'), "切回角色");
      assert.equal(await evaluate('document.querySelector("#nativeInput").value'), "尚未发送的草稿");
      for (const page of ["memory", "life", "schedule", "interaction", "extensions"]) {
        await evaluate(`go(${JSON.stringify(page)})`);
        await until(
          () =>
            evaluate(
              'Boolean(document.querySelector("#content .card") && !document.querySelector("#content .skeleton"))',
            ),
          page,
        );
        assert.ok(!(await evaluate('document.querySelector("#content").innerText.includes("这个页面出错了")')), page);
        if (page === "life")
          assert.ok(await evaluate('document.querySelector("#content").innerText.includes("明天别忘了陪我去看海")'));
        if (page === "schedule") {
          assert.ok(await evaluate('document.querySelector("#scheduleTarget").value.startsWith("local-")'));
          await evaluate(
            'api("/api/schedule/greet", {kind:"proactive", userId:document.querySelector("#scheduleTarget").value, text:"我来心语找你啦"})',
          );
        }
        if (page === "interaction") {
          await evaluate('document.querySelector("#memoryQuickLocal").click()');
          await until(() => evaluate('Boolean(document.querySelector("#memorySetupConfirm"))'), "长期记忆使用说明");
          await evaluate('document.querySelector("#memorySetupConfirm").click()');
          await until(
            () =>
              evaluate(
                'Boolean(document.querySelector("#memorySetupState") && document.querySelector("#memorySetupState").innerText.includes("本地长期记忆已开启"))',
              ),
            "一键启用长期记忆",
          );
        }
      }
      const archived = await evaluate('api("/api/next/memory/archive", {})');
      assert.equal(archived.ok, true);
      assert.ok(archived.archived > 0);
      for (const page of ["memory", "life"]) {
        const expected = page === "memory" ? "她记住了明天与对方一起看海的约定，心里有些期待。" : "我把明天和你一起看海的约定放在心里，已经开始偷偷期待了。";
        await evaluate(`go(${JSON.stringify(page)})`);
        await until(
          () =>
            evaluate(
              `document.querySelector("#content").textContent.includes(${JSON.stringify(expected)})`,
            ),
          "当日记忆或经历出现在" + page,
        );
        await evaluate('document.querySelectorAll("#content details").forEach(el => el.open = true)');
        assert.ok(
          await evaluate(
            `document.querySelector("#content").innerText.includes(${JSON.stringify(expected)})`,
          ),
        );
      }
      assert.equal(await evaluate('document.querySelector("#lifeDailyEnabled").checked'), false);
      assert.equal(await evaluate('document.querySelector("#content").innerText.includes("她记住了明天与对方一起看海的约定")'), false);
      await evaluate('document.querySelector("#lifeDailyEnabled").click()');
      await until(() => evaluate('Boolean(document.querySelector("#lifeDailyEnabled")?.checked && !document.querySelector("#btnDailyLife").disabled)'), "开启她的日常");
      const dailyDb = new DatabaseSync(path.join(data, "database", "main.db"));
      dailyDb.prepare("update messages set at=at-7200000 where scope_key=? and direction='in'").run(historyScope);
      dailyDb.close();
      await evaluate('document.querySelector("#btnDailyLife").click()');
      await until(() => evaluate('document.querySelector("#content").textContent.includes("我独自翻了几页书")'), "她的日常生成并展示");
      assert.ok(await evaluate('Array.from(document.querySelectorAll(".tl-item")).some(el => el.innerText.includes("我独自翻了几页书") && el.innerText.includes("她的日常"))'));
      fs.mkdirSync(path.join(root, "build", "dev10-life-qa"), { recursive: true });
      fs.writeFileSync(path.join(root, "build", "dev10-life-qa", (process.env.HEARTECHO_TEST_EDITION || "generic") + ".png"), Buffer.from((await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true })).data, "base64"));
      await evaluate('document.querySelector("#lifeDailyEnabled").click()');
      const logDate = new Date(Date.now() - 86400000).toLocaleDateString("en-CA");
      fs.writeFileSync(
        path.join(tmp, "logs", `heartecho-${logDate}.log`),
        Array.from({ length: 850 }, (_, n) => `12:00:00 INFO  [BrowserFixture] persisted-log-${n};`).join("\n") + "\n",
      );
      await evaluate('go("logs")');
      await until(() => evaluate('Boolean(document.querySelector("#logDate"))'), "日志日期选择");
      await evaluate(
        'document.querySelector("#logLevel").value="info"; document.querySelector("#logLevel").dispatchEvent(new Event("change"))',
      );
      await until(() => evaluate('LOG_LEVEL_FLOOR === "info"'), "日志信息级别");
      await evaluate(
        'document.querySelector("#logDate").value=' +
          JSON.stringify(logDate) +
          '; document.querySelector("#logDate").dispatchEvent(new Event("change"))',
      );
      await until(
        () =>
          evaluate(
            'Boolean(document.querySelector("#logBox") && document.querySelector("#logBox").innerText.includes("persisted-log-849;"))',
          ),
        "落盘日志显示",
      );
      await evaluate('document.querySelector("#logOlder").click()');
      await until(
        () => evaluate('document.querySelector("#logBox").innerText.includes("persisted-log-100;")'),
        "日志历史第一页",
      );
      await evaluate('document.querySelector("#logOlder").click()');
      await until(
        () => evaluate('document.querySelector("#logBox").innerText.includes("persisted-log-0;")'),
        "日志超过800条仍可翻页",
      );
      await evaluate('go("chat")');
      await until(
        () =>
          evaluate(
            'Boolean(document.querySelector("#nativeLog") && document.querySelector("#nativeLog").innerText.includes("我来心语找你啦"))',
          ),
        "主动消息显示",
      );
      const shotDir = path.join(root, "build", "local-chat-qa");
      fs.mkdirSync(shotDir, { recursive: true });
      const shot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      fs.writeFileSync(path.join(shotDir, "角色对话.png"), Buffer.from(shot.data, "base64"));
      // 重开窗口已自动展示过失败提示；这里通过用户实际的手动检查入口再次请求提示。
      await evaluate('go("system")');
      await until(() => evaluate('Boolean(document.querySelector("#appCheckUpdate"))'), "手动检查更新入口");
      await evaluate('document.querySelector("#appCheckUpdate").click()');
      await until(() => evaluate('Boolean(document.querySelector("#githubSuppress"))'), "GitHub 断网提示");
      await evaluate('document.querySelector("#githubSuppress").click()');
      await until(() => evaluate('document.querySelector("#modal").classList.contains("hidden")'), "今日不再提示");
      // 真正保存开关，再重开面板；天气完全来自隔离的模拟服务。
      await evaluate('api("/api/weather/settings", {enabled:true,city:"测试港",autoLocate:false,proactive:{enabled:false}})');
      await evaluate('go("weather")');
      await until(() => evaluate('Boolean(document.querySelector("#firstOpenEnabled"))'), "天气页首次打开选项");
      assert.equal(await evaluate('document.querySelector("#firstOpenEnabled").checked'), false);
      await evaluate('document.querySelector("#firstOpenEnabled").click();document.querySelector("#btnSaveFirstOpen").click()');
      await until(() => evaluate('Boolean(S.weatherLive?.firstOpen?.enabled && document.querySelector("#firstOpenEnabled")?.checked)'), "保存首次打开问候");
      await evaluate('go("schedule")');
      await until(() => evaluate('Boolean(document.querySelector("#firstOpenEnabled")?.checked)'), "日程页同步开关");
      assert.equal(modelCalls.filter(call => call.messages.some(m => m.content.includes("今天第一次打开心语"))).length, 0, "保存设置本身不发送问候");
      fs.mkdirSync(path.join(root,"build","dev11-first-open-qa"), {recursive:true});
      fs.writeFileSync(path.join(root,"build","dev11-first-open-qa",(process.env.HEARTECHO_TEST_EDITION || "source")+".png"), Buffer.from((await cdp("Page.captureScreenshot", {format:"png",captureBeyondViewport:false})).data,"base64"));
      const firstOpenTimeOrigin = await evaluate('performance.timeOrigin');
      await cdp("Page.reload");
      await until(async () => { try { return await evaluate('performance.timeOrigin !== ' + firstOpenTimeOrigin + ' && typeof S !== "undefined" && Boolean(S.panelReady)'); } catch { return false; } }, "重新打开面板完成");
      await until(() => evaluate('api("/api/chat/local?characterId=first").then(s=>s.messages?.some(m=>m.body.includes("测试港今天预报中雨")))'), "第一次打开自动问候和天气入库");
      assert.equal(modelCalls.filter(call => call.messages.some(m => m.content.includes("今天第一次打开心语"))).length, 1);
      const welcomeCall = modelCalls.find(call => call.messages.some(m => m.content.includes("今天第一次打开心语")));
      assert.ok(welcomeCall.messages.some(m=>m.content.includes("测试港今天中雨") && m.content.includes("12~19℃")));
      const sameDayTimeOrigin = await evaluate('performance.timeOrigin');
      await cdp("Page.reload");
      await until(async () => { try { return await evaluate('performance.timeOrigin !== ' + sameDayTimeOrigin + ' && typeof S !== "undefined" && Boolean(S.panelReady)'); } catch { return false; } }, "同日再次打开");
      assert.equal(modelCalls.filter(call => call.messages.some(m => m.content.includes("今天第一次打开心语"))).length, 1);
      await evaluate('go("chat")');
      await until(() => evaluate('Boolean(document.querySelector("#nativeInput"))'), "回到角色对话");
      await cdp("Page.reload");
      await until(
        () =>
          evaluate('typeof S !== "undefined" && Boolean(S.nativeHistory && document.querySelector("#nativeInput"))'),
        "刷新后聊天",
      );
      assert.equal(await evaluate('api("/api/updates").then(s=>s.githubPrompt)'), false);
      fs.writeFileSync(githubMode, "available");
      await evaluate('api("/api/updates/check", {})');
      await until(() => evaluate('Boolean(document.querySelector("#updateDownload"))'), "发现新版本");
      assert.equal(await evaluate('Boolean(document.querySelector("#modal script"))'), false);
      await evaluate('document.querySelector("#updateDownload").click()');
      await until(() => evaluate('Boolean(document.querySelector("#updateInstall"))'), "下载校验完成等待安装同意");
      assert.equal(await evaluate('api("/api/updates").then(s=>s.state)'), "ready");
      await evaluate('document.querySelector("#modalClose").click()');
      await evaluate('go("system")');
      await until(() => evaluate('Boolean(document.querySelector("#btnExportMigration"))'), "完整迁移入口");
      await evaluate('window.confirm=()=>true; document.querySelector("#btnExportMigration").click()');
      await until(
        () => evaluate('document.querySelector("#modal").innerText.includes("完整迁移数据已导出")'),
        "导出成功说明",
      );
      const exported = await evaluate('document.querySelector("#modal p.mono").innerText');
      assert.ok(fs.existsSync(path.join(exported, "database", "main.db")));
      assert.ok(fs.existsSync(path.join(exported, "characters", "first.json")));
      assert.equal(JSON.parse(fs.readFileSync(path.join(exported, "config.json"))).llm.profiles.default.apiKey, "");
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(data, "config.json"))).llm.profiles.default.apiKey,
        "mock-browser",
      );
      const migrationShot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      fs.writeFileSync(
        path.join(shotDir, "完整迁移-" + (process.env.HEARTECHO_TEST_EDITION || "source") + ".png"),
        Buffer.from(migrationShot.data, "base64"),
      );
      assert.deepEqual(errors, []);
      await evaluate('document.querySelector("#modalClose")?.click()');
      for (const page of ["overview", "account", "dialog", "weather", "interaction", "extensions", "studio", "chat", "groups", "memory", "life", "schedule", "qzone", "llm", "system", "logs"]) {
        await evaluate(`go(${JSON.stringify(page)})`);
        await until(() => evaluate('document.querySelector("#content").innerText.length > 40 && !document.querySelector("#content .skeleton")'), "页面就绪：" + page);
        assert.equal(await evaluate('document.querySelector("#content").innerText.includes("这个页面出错了")'), false, page);
      }
      assert.deepEqual(errors, []);
      await evaluate('go("studio")');
      await until(() => evaluate('Boolean(document.querySelector("#saveEvolution"))'), "她的迭代设置");
      assert.equal(await evaluate('Boolean(document.querySelector("#lk_persona"))'), false);
      await evaluate('document.querySelector("#evolutionEnabled").click(); document.querySelector("#saveEvolution").click()');
      await until(() => evaluate('api("/api/continuity").then(x=>x.evolution.enabled && Boolean(x.evolution.original))'), "原始角色卡保留");
      await evaluate('go("groups")');
      await until(() => evaluate('Boolean(document.querySelector("#nxQuotaGroup"))'), "群与成员额度已归入群设置");
      await evaluate('go("interaction")');
      await until(() => evaluate('Boolean(document.querySelector("#memoryQuickLocal"))'), "记忆设置");
      assert.equal(await evaluate('Boolean(document.querySelector("#nxQuotaGroup"))'), false);
      await evaluate('go("life")');
      await until(() => evaluate('Boolean(document.querySelector("#enableBody"))'), "身体初始化表单");
      assert.equal(await evaluate('Boolean(document.querySelector("#lifeScope"))'), true);
      await evaluate('document.querySelector("#bodyVariation").value="0";document.querySelector("#bodyCycle").click();document.querySelector("#bodyConfirm").click();document.querySelector("#enableBody").click()');
      await until(() => evaluate('Boolean(document.querySelector("#viewBodyMonth"))'), "身体月表");
      assert.equal(await evaluate('Boolean(document.querySelector("#enableBody"))'), false);
      await evaluate('document.querySelector("#bodyMonth").value="2027-02";document.querySelector("#viewBodyMonth").click()');
      await until(() => evaluate('document.querySelector("#content").innerText.includes("2027-02-28")'), "跨月查看");
      for (const stage of ["经期", "卵泡期", "排卵期（预计）", "黄体早期", "黄体晚期（经前）", "排卵日期估算范围内"]) {
        assert.ok((await evaluate('document.querySelector("#bodyCalendar").innerText')).includes(stage), stage);
      }
      await evaluate('document.querySelector("#cycleGuide").open=true');
      assert.match(await evaluate('document.querySelector("#cycleGuide").innerText'), /10–16/);
      await evaluate('document.querySelector("#bodyCalendar details").open=true');
      assert.match(await evaluate('document.querySelector("#bodyCalendar").innerText'), /下次经期预计/);
      const oldTimeOrigin = await evaluate('performance.timeOrigin');
      await cdp("Page.reload");
      await until(async () => { try { return await evaluate('performance.timeOrigin !== ' + oldTimeOrigin + ' && document.readyState === "complete" && typeof go === "function" && Boolean(document.querySelector("#content")?.innerText.length > 40)'); } catch { return false; } }, "刷新后新文档初始化完成");
      await evaluate('go("life")');
      await until(() => evaluate('Boolean(document.querySelector("#viewBodyMonth"))'), "刷新后身体状态仍保留");
      await evaluate('document.querySelector("#modalClose")?.click()');
      await evaluate('document.querySelector("#bodyMonth").value="2027-02";document.querySelector("#viewBodyMonth").click()');
      await until(() => evaluate('document.querySelector("#bodyCalendar")?.innerText.includes("2027-02-28")'), "刷新后跨月阶段");
      await evaluate('document.querySelector("#cycleGuide").open=true;document.querySelector("#cycleGuide").closest(".card").scrollIntoView()');
      fs.mkdirSync(path.join(root,"build","dev171-life-qa"),{recursive:true});
      fs.writeFileSync(path.join(root,"build","dev171-life-qa",(process.env.HEARTECHO_TEST_EDITION || "generic")+".png"),Buffer.from((await cdp("Page.captureScreenshot",{format:"png",captureBeyondViewport:true})).data,"base64"));
      assert.deepEqual(errors, []);
      await evaluate('go("schedule")');
      await until(() => evaluate('Boolean(document.querySelector("#btnAddBd"))'), "生日表单");
      await evaluate('document.querySelector("#bd_name").value="我";document.querySelector("#bd_md").value="03-15";document.querySelector("#bd_qq").value="";document.querySelector("#btnAddBd").click()');
      await until(() => evaluate('api("/api/schedule").then(x=>x.birthdays.some(b=>b.month_day==="03-15"))'), "日程生日保存");
      await evaluate('go("chat")');
      await until(() => evaluate('Boolean(document.querySelector("#nativeSend") && S.nativeHistory)'), "生日回忆对话");
      const beforeBirthdayCalls=modelCalls.length;
      await evaluate('document.querySelector("#nativeInput").value="你记得我的生日吗";document.querySelector("#nativeInput").dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#nativeSend").click()');
      await until(() => modelCalls.slice(beforeBirthdayCalls).some(call=>JSON.stringify(call).includes("03-15")), "日程生日实际进入聊天模型请求");
      assert.deepEqual(errors, []);
      const connections = await evaluate('api("/api/status").then(s=>({qq:s.onebot.online,master:s.bots.masterId}))');
      assert.equal(Boolean(connections.qq), false);
      assert.equal(connections.master, 0);
    } finally {
      for (const task of pending.values()) clearTimeout(task.timer);
      ws?.close();
      for (const child of [app, browser]) {
        if (child.exitCode === null) {
          child.kill();
          await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(3000)]);
        }
      }
      await new Promise((resolve) => model.close(resolve));
      assert.equal(path.dirname(tmp), os.tmpdir());
      assert.ok(path.basename(tmp).startsWith("heartecho-local-browser-"));
      // 浏览器子进程退出后释放配置目录。
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);
