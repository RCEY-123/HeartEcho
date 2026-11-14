import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const installers = String(process.env.HEARTECHO_TEST_INSTALLERS || "").split(path.delimiter).filter(Boolean);
const previous = String(process.env.HEARTECHO_TEST_PREVIOUS_INSTALLERS || "").split(path.delimiter).filter(Boolean);
for (const setup of installers) test(`实际安装器的新目录与自定义目录兼容：${path.basename(setup)}`, { timeout: 40000 }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "heartecho-installed-storage-"));
  try {
    const tb = path.basename(setup).startsWith("领航员终端"), edition = tb ? "tb" : "generic";
    const local = path.join(tmp, "local"), target = path.join(tmp, "fresh"), customTarget = path.join(tmp, "custom-program"), custom = path.join(tmp, "chosen-data");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HEARTECHO_")));
    Object.assign(env, { LOCALAPPDATA: local, APPDATA: path.join(tmp, "roaming"), TEMP: tmp, TMP: tmp, HEARTECHO_UPDATE_CHECK: "0" });
    const install = (file, directory) => {
      const result = spawnSync(file, ["--silent", "--accept-license", "--dir=" + directory], { env, encoding: "utf8", windowsHide: true, timeout: 25000 });
      assert.equal(result.status, 0, result.stderr || result.error?.message);
    };
    install(setup, target);
    const settingsName = tb ? "心语TB设置.json" : "心语设置.json";
    assert.equal(JSON.parse(fs.readFileSync(path.join(target, settingsName))).dataDir, path.join(target, "data"));
    const uri = name => JSON.stringify(pathToFileURL(path.join(target, "app/lib", name)).href);
    const source = `${tb ? 'process.argv.push("--tb");' : ''} await import(${uri('boot-env.mjs')}); const {paths,ensureDirs}=await import(${uri('paths.mjs')});ensureDirs(); const {loadConfig}=await import(${uri('config.mjs')}); const config=loadConfig();console.log(JSON.stringify({data:paths.data,logs:paths.logs,keysEmpty:Object.values(config.llm.profiles).every(p=>!p.apiKey),onboard:config.onboarding.done}));`;
    const checked = spawnSync(path.join(target, "runtime/node.exe"), ["--input-type=module", "-e", source], { env: { ...env, HEARTECHO_APP_DIR: target, HEARTECHO_INSTALL_ROOT: target, HEARTECHO_INSTALLED: "1" }, encoding: "utf8", windowsHide: true, timeout: 10000 });
    assert.equal(checked.status, 0, checked.stderr);
    const got = JSON.parse(checked.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(got.data, path.join(target, "data")); assert.equal(got.logs, path.join(target, "data/logs"));
    assert.equal(got.keysEmpty, true); assert.equal(got.onboard, false);
    assert.equal(fs.existsSync(path.join(local, tb ? "心语TB" : "心语")), false);
    const old = previous.find(file => path.basename(file).startsWith(tb ? "领航员终端" : "心语-"));
    assert(old, "需要提供上一版安装包用于自定义目录覆盖升级");
    install(old, customTarget);
    fs.mkdirSync(custom, { recursive: true }); fs.writeFileSync(path.join(custom, "config.json"), '{"synthetic":"preserve"}');
    // dev.7 起 TB 也优先读取程序目录的设置；只有旧安装没有该文件时才回退 AppData。
    const localSetting = path.join(customTarget, settingsName);
    const setting = fs.existsSync(localSetting) || !tb ? localSetting : path.join(local, "心语TB", settingsName);
    fs.mkdirSync(path.dirname(setting), { recursive: true });
    fs.writeFileSync(setting, JSON.stringify({ dataDir: custom, logDir: path.join(custom, "special-logs"), autoStartProtocol: false }));
    install(setup, customTarget);
    const preserved = JSON.parse(fs.readFileSync(path.join(customTarget, settingsName)));
    assert.equal(preserved.dataDir, custom); assert.equal(preserved.logDir, path.join(custom, "special-logs")); assert.equal(preserved.autoStartProtocol, false);
    assert.equal(fs.existsSync(path.join(customTarget, "data")), false);
    assert.equal(fs.readFileSync(path.join(custom, "config.json"), "utf8"), '{"synthetic":"preserve"}');
    assert.equal(fs.readFileSync(path.join(customTarget, "INSTALL-EDITION.txt"), "utf8").trim(), edition);
    const removeArgs = ["--silent", "--uninstall-direct", "--accept-uninstall", "--no-register", "--delete-data", "--dir=" + target];
    assert.equal(spawnSync(setup, removeArgs, { env, windowsHide: true, timeout: 10000 }).status, 2, "删除独立数据仍须明确确认");
    assert.equal(spawnSync(setup, [...removeArgs, "--confirm-delete-data"], { env, windowsHide: true, timeout: 10000 }).status, 0);
    assert.equal(fs.existsSync(path.join(target, "data")), false);
    assert.equal(fs.readFileSync(path.join(custom, "config.json"), "utf8"), '{"synthetic":"preserve"}', "删除一个安装的数据不能影响另一目录");
  } finally { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
