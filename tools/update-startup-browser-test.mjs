// 隔离真实应用 + 模拟 GitHub + 实际浏览器，验证启动/重开窗口的更新提示。
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
const appVersion = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8")).version;
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


for (const edition of (process.env.HEARTECHO_TEST_EDITION ? [process.env.HEARTECHO_TEST_EDITION] : ["generic", "tb"])) {
  test(`browser updates: ${edition} startup, reopening, offline diagnostics, suppression, retry and consent`,
    { timeout: 60000, skip: !browserPath }, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "heartecho-update-browser-"));
    const data = path.join(tmp, "data");
    const browserPort = await freePort(), panelPort = await freePort();
    fs.mkdirSync(data, { recursive: true });
    fs.mkdirSync(path.join(data, "state"), { recursive: true });
    fs.writeFileSync(path.join(data, "state", "updates.json"), JSON.stringify({ lastRunVersion: "1.3.0-dev.17" }));
    fs.writeFileSync(path.join(data, "config.json"), JSON.stringify({
      tb: { initialized: true }, bot: { selfId: 0, masterId: 0, panelPort },
      onboarding: { done: true }, weather: { enabled: false },
    }));
    const modeFile = path.join(tmp, "mode.txt"), callsFile = path.join(tmp, "calls.jsonl");
    fs.writeFileSync(modeFile, "offline");
    const preload = path.join(tmp, "github-fixture.mjs");
    fs.writeFileSync(preload, `import fs from 'node:fs'; import { createHash } from 'node:crypto';
const modeFile=${JSON.stringify(modeFile)}, callsFile=${JSON.stringify(callsFile)};
const original=globalThis.fetch;
const version='9.9.9-dev.999', bytes=Buffer.from('synthetic installer: never execute');
const sha=createHash('sha256').update(bytes).digest('hex');
const assets=['HeartEcho-','HeartEcho-TB-'].flatMap(prefix=>{const name=prefix+version+'-Setup.exe'; const url='https://github.com/RCEY-123/HeartEcho/releases/download/v'+version+'/'; return [{name,size:bytes.length,browser_download_url:url+name},{name:name+'.sha256',browser_download_url:url+name+'.sha256'}];});
globalThis.fetch=async (url,options={})=>{
  const address=String(url), host=new URL(address).hostname;
  if(host==='api.github.com') {
    fs.appendFileSync(callsFile,JSON.stringify({type:'metadata',cache:options.cache,privateHeaders:Boolean(options.headers?.Authorization||options.headers?.authorization),body:Boolean(options.body)})+String.fromCharCode(10));
    if(fs.readFileSync(modeFile,'utf8')==='offline')throw new TypeError('fetch failed',{cause:{code:'ENOTFOUND'}});
    return new Response(JSON.stringify([{tag_name:'v'+version,prerelease:true,body:'新版本说明 <script>不得执行</script>',assets}]));
  }
  if(host==='github.com') {
    fs.appendFileSync(callsFile,JSON.stringify({type:'download'})+String.fromCharCode(10));
    const name=decodeURIComponent(new URL(address).pathname.split('/').at(-1));
    return name.endsWith('.sha256')?new Response(sha+'  '+name.slice(0,-7)):new Response(bytes);
  }
  if(host!=='127.0.0.1')throw new Error('external network blocked in test');
  return original(url,options);
};`);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HEARTECHO_") && !["NODE_TEST_CONTEXT", "NODE_OPTIONS"].includes(key)));
    Object.assign(env, {
      HEARTECHO_APP_DIR: appRoot, HEARTECHO_DATA_DIR: data, HEARTECHO_EDITION: edition,
      HEARTECHO_SETTINGS: path.join(tmp, "settings.json"), HEARTECHO_LOG_DIR: path.join(tmp, "logs"),
      HEARTECHO_SNOWLUMA_DIR: path.join(tmp, "no-protocol"), HEARTECHO_CLAIM_DIR: path.join(tmp, "claims"),
      HEARTECHO_INSTANCES_HOME: path.join(tmp, "instances"), LOCALAPPDATA: path.join(tmp, "local"), HEARTECHO_LOG_LEVEL: "error",
    });
    if (process.env.HEARTECHO_TEST_APP_ROOT) Object.assign(env, { HEARTECHO_INSTALLED: "1", HEARTECHO_INSTALL_ROOT: path.dirname(appRoot) });
    const app = spawn(process.execPath, ["--import", pathToFileURL(preload).href, "index.mjs", "--no-panel", "--no-tray", "--no-autostart"], { cwd: appRoot, env, stdio: "pipe", windowsHide: true });
    let output = "";
    app.stdout.on("data", chunk => { output += chunk; });
    app.stderr.on("data", chunk => { output += chunk; });
    const browser = spawn(browserPath, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${path.join(tmp, "browser")}`, `--remote-debugging-port=${browserPort}`, "--window-size=1280,1080", "about:blank"], { stdio: "ignore", windowsHide: true });
    let ws, sequence = 0;
    const pending = new Map(), errors = [];
    const calls = () => fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8").trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : [];
    try {
      await until(async () => { try { return (await fetch(`http://127.0.0.1:${panelPort}/`)).ok; } catch { if(app.exitCode!==null)throw Error(output); return false; } }, "应用启动");
      await until(() => calls().some(call => call.type === "metadata"), "进程启动自动访问 GitHub，不依赖窗口");
      const targets = await until(async () => { try { return (await fetch(`http://127.0.0.1:${browserPort}/json/list`)).json(); } catch { return false; } }, "浏览器启动");
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
      const url = `http://127.0.0.1:${panelPort}/#panelToken=${token}`;
      const open = async () => {
        await cdp("Page.navigate", { url: "about:blank" });
        await until(() => evaluate('location.href === "about:blank"'), "旧窗口关闭");
        await cdp("Page.navigate", { url });
        await until(() => evaluate('Boolean(document.querySelector("#btnSandboxJump"))'), "新窗口就绪");
      };
      const startupCalls = calls().length;
      await open();
      await until(() => calls().length > startupCalls, "打开窗口必须重新请求仓库，而非只读启动结果");
      await until(() => evaluate('document.querySelector("#modal")?.innerText.includes("已更新到")'), "升级后自动展示本版说明");
      const noticeText = await evaluate('document.querySelector("#modal").innerText');
      assert.ok(noticeText.includes(appVersion));
      assert.match(noticeText, /本次更新/);
      assert.match(noticeText, /快捷导入、导出和删除角色卡/);
      assert.match(noticeText, /\[::thought\]::/);
      assert.doesNotMatch(noticeText, /累计改进|dev\.1[2-7]|她的迭代|生理期/);
      assert.equal(noticeText.split("•").length - 1, 3, "only three concise current-release changes are shown");
      const noticeShot = await cdp("Page.captureScreenshot", { format: "png" });
      const noticeShots = path.join(root, "build", "dev18-update-qa");
      fs.mkdirSync(noticeShots, { recursive: true });
      fs.writeFileSync(path.join(noticeShots, `${edition}-updated-notice.png`), Buffer.from(noticeShot.data, "base64"));
      await evaluate('document.querySelector("#updateStartGuide").click()');
      await until(() => evaluate('Boolean(document.querySelector("#featureGuideCard"))'), "公告进入角色工作室引导");
      assert.equal(await evaluate('S.page'), "studio");
      const assertGuide = async (selector) => {
        assert.equal(await evaluate('document.querySelector("#featureGuideHighlight").dataset.target'), selector);
        const geometry = await evaluate(`(() => {
          const t = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
          const r = document.querySelector('#featureGuideHighlight').getBoundingClientRect();
          const c = document.querySelector('#featureGuideCard').getBoundingClientRect();
          return {ringVisible:r.width>0&&r.height>0,contains:r.left<=t.left&&r.top<=t.top&&r.right>=t.right&&r.bottom>=t.bottom,cardVisible:c.left>=0&&c.top>=0&&c.right<=innerWidth&&c.bottom<=innerHeight,arrow:document.querySelector('#featureGuideLine').getAttribute('d'),focus:document.querySelector('#featureGuideCard').contains(document.activeElement)};
        })()`);
        assert.equal(geometry.ringVisible && geometry.contains && geometry.cardVisible && geometry.focus, true, JSON.stringify(geometry));
        assert.match(geometry.arrow, /^M[\d.\-, ]+ Q/);
      };
      await assertGuide("#characterCardImport");
      await evaluate('maybeShowUpdates()');
      assert.equal(await evaluate('document.querySelector("#modal").classList.contains("hidden")'), true, "network prompt does not interrupt a tour");
      const guideShot = await cdp("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(noticeShots, `${edition}-feature-guide.png`), Buffer.from(guideShot.data, "base64"));
      await evaluate('document.querySelector("#featureGuideNext").click()');
      await assertGuide("#characterCardExport");
      await evaluate('document.querySelector("#featureGuidePrevious").click()');
      await assertGuide("#characterCardImport");
      await evaluate('document.querySelector("#featureGuideNext").click(); document.querySelector("#featureGuideNext").click()');
      await assertGuide("#characterCardDelete");
      await cdp("Emulation.setDeviceMetricsOverride", { width: 480, height: 800, deviceScaleFactor: 1, mobile: false });
      await until(() => evaluate('innerWidth === 480'), "窄窗口引导布局");
      await evaluate('document.querySelector("#characterCardDelete").scrollIntoView({block:"center"}); positionFeatureGuide()');
      await assertGuide("#characterCardDelete");
      const narrowShot = await cdp("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(noticeShots, `${edition}-feature-guide-narrow.png`), Buffer.from(narrowShot.data, "base64"));
      await cdp("Emulation.clearDeviceMetricsOverride");
      await evaluate('document.querySelector("#featureGuideNext").click()');
      assert.equal(await evaluate('Boolean(document.querySelector("#featureGuide"))'), false);
      await until(() => evaluate('api("/api/updates").then(s => s.notice === null)'), "开始引导后持久保存已读状态");
      const savedNotice = JSON.parse(fs.readFileSync(path.join(data, "state", "updates.json"), "utf8"));
      assert.equal(savedNotice.acknowledgedVersion, appVersion);
      assert.equal(savedNotice.notice, undefined);
      await open();
      await until(() => evaluate('Boolean(document.querySelector("#githubRetry"))'), "首次打开自动显示无法访问 GitHub");
      assert.equal(await evaluate('Boolean(document.querySelector("#featureGuide"))'), false, "completed guide is not repeated after reopening");
      assert.match(await evaluate('document.querySelector("#modal").innerText'), /DNS/);
      assert.equal(await evaluate('api("/api/updates").then(s=>s.failureKind)'), "dns");
      assert.equal(calls().filter(call => call.type === "download").length, 0);
      const shots = path.join(root, "build", "dev18-update-qa"); fs.mkdirSync(shots, { recursive: true });
      const shot = await cdp("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(shots, `${edition}-github-unavailable.png`), Buffer.from(shot.data, "base64"));
      await evaluate('document.querySelector("#modalClose").click()');
      const before = calls().length;
      fs.writeFileSync(modeFile, "available");
      await open();
      await until(() => calls().length > before, "后台进程未退出时重开窗口仍访问仓库");
      await until(() => evaluate('Boolean(document.querySelector("#updateDownload"))'), "重开窗口检测英文资产并提示更新");
      assert.match(await evaluate('document.querySelector("#modal").innerText'), /新版本说明/);
      assert.equal(await evaluate('api("/api/updates").then(s=>s.release.name)'), `${edition === "tb" ? "HeartEcho-TB-" : "HeartEcho-"}9.9.9-dev.999-Setup.exe`);
      assert.equal(await evaluate('Boolean(document.querySelector("#modal script"))'), false);
      assert.equal(calls().filter(call => call.type === "download").length, 0, "发现更新仍需下载同意");
      await evaluate('document.querySelector("#modalClose").click()');
      fs.writeFileSync(modeFile, "offline");
      await open();
      await until(() => evaluate('Boolean(document.querySelector("#githubSuppress"))'), "再次断网重开仍提示");
      await evaluate('document.querySelector("#githubSuppress").click()');
      await until(() => evaluate('document.querySelector("#modal").classList.contains("hidden")'), "今日不再提示保存");
      const suppressedBefore = calls().length;
      await open();
      await until(() => calls().length > suppressedBefore, "隐藏提示仍检查网络");
      await evaluate('maybeShowUpdates()');
      assert.equal(await evaluate('Boolean(document.querySelector("#githubRetry"))'), false);
      await evaluate('go("system")');
      await until(() => evaluate('Boolean(document.querySelector("#appCheckUpdate"))'), "手动检查入口");
      await evaluate('document.querySelector("#appCurrentRelease").click()');
      await until(() => evaluate('Boolean(document.querySelector("#updateStartGuide"))'), "已读公告可以手动重看");
      assert.ok((await evaluate('document.querySelector("#modal").innerText')).includes(appVersion));
      await evaluate('document.querySelector("#modalClose").click()');
      await until(() => evaluate('document.querySelector("#modal").classList.contains("hidden")'), "稍后再看可关闭公告");
      await evaluate('document.querySelector("#appCurrentRelease").click()');
      await until(() => evaluate('Boolean(document.querySelector("#updateStartGuide"))'), "重看引导入口");
      await evaluate('document.querySelector("#updateStartGuide").click()');
      await until(() => evaluate('Boolean(document.querySelector("#featureGuideSkip"))'), "重看引导已开始");
      await evaluate('document.querySelector("#featureGuideSkip").click()');
      assert.equal(await evaluate('Boolean(document.querySelector("#featureGuide"))'), false);
      await open();
      assert.equal(await evaluate('Boolean(document.querySelector("#featureGuide"))'), false, "skipped guide is not repeated after reopening");
      await evaluate('go("system")');
      await until(() => evaluate('Boolean(document.querySelector("#appCheckUpdate"))'), "返回手动更新检查");
      await evaluate('document.querySelector("#appCheckUpdate").click()');
      await until(() => evaluate('Boolean(document.querySelector("#githubRetry"))'), "主动检查不受自动提示抑制");
      fs.writeFileSync(modeFile, "available");
      await evaluate('document.querySelector("#githubRetry").click()');
      await until(() => evaluate('Boolean(document.querySelector("#updateDownload"))'), "网络恢复后重新检查");
      await evaluate('document.querySelector("#updateDownload").click()');
      await until(() => evaluate('Boolean(document.querySelector("#updateInstall"))'), "同意下载后校验正确，等待安装同意");
      assert.equal(await evaluate('api("/api/updates").then(s=>s.state)'), "ready");
      assert.equal(calls().filter(call => call.type === "download").length, 2);
      assert.ok(calls().filter(call => call.type === "metadata").every(call => !call.privateHeaders && !call.body && call.cache === "no-store"));
      assert.deepEqual(errors, []);
    } finally {
      for (const task of pending.values()) clearTimeout(task.timer);
      ws?.close();
      for (const child of [app, browser]) if (child.exitCode === null) { child.kill(); await Promise.race([new Promise(resolve => child.once("exit",resolve)),delay(3000)]); }
      assert.equal(path.dirname(tmp), os.tmpdir());
      assert.ok(path.basename(tmp).startsWith("heartecho-update-browser-"));
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
}
