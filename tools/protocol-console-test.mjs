import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { setProtocolConsole } from "../lib/protocol-console.mjs";

test("Windows 仅隐藏所选目录的独立启动器控制台，拒绝其它进程", { skip: process.platform !== "win32", timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "heartecho console "));
  const entry = path.join(dir, "index.mjs"), receipt = path.join(dir, "pid.txt");
  fs.writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(receipt)},String(process.pid));setInterval(()=>{},1000);`.replace("require('node:fs')", "(await import('node:fs')).default"));
  fs.writeFileSync(path.join(dir, "launcher.bat"), `@echo off\r\n"${process.execPath}" "${entry}"\r\n`);
  const launcher = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `""${path.join(dir, "launcher.bat")}""`], { windowsHide: true, windowsVerbatimArguments: true, stdio: "ignore" });
  let child = 0;
  try {
    for (let i=0;i<100&&!fs.existsSync(receipt);i++) await new Promise(r=>setTimeout(r,50));
    child = Number(fs.readFileSync(receipt, "utf8"));
    const hidden = await setProtocolConsole({ pid: child, dir });
    assert.equal(hidden.ok, true, JSON.stringify(hidden));
    assert.equal(hidden.hidden, true);
    assert.equal((await setProtocolConsole({ pid: child, dir: path.join(dir, "different") })).ok, false);
    assert.equal((await setProtocolConsole({ pid: process.pid, dir })).ok, false);
    process.kill(child, 0);
  } finally {
    if (child) try { process.kill(child); } catch { /* 测试子进程已结束 */ }
    launcher.kill();
    await new Promise(r=>setTimeout(r,200));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
