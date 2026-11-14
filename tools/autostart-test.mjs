import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("自启识别 Windows 禁用和旧路径，显式开启修复当前实例", { skip: process.platform !== "win32", timeout: 30000 }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "心语 自启测试-"));
  const script = `
    import assert from 'node:assert/strict';
    import path from 'node:path';
    import { execFileSync } from 'node:child_process';
    import { autostartStatus, installAutostart, removeAutostart } from './lib/desktop.mjs';
    const ps = (source) => execFileSync('powershell', ['-NoProfile', '-Command', '$ErrorActionPreference="Stop"; ' + source], { windowsHide: true });
    const key = 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Explorer/StartupApproved/StartupFolder';
    let file;
    try {
      const first = installAutostart();
      assert.equal(first.ok, true, first.error);
      file = first.file;
      assert.ok(file.startsWith(process.env.APPDATA));
      assert.equal(autostartStatus().enabled, true);
      const name = path.basename(file).replaceAll("'", "''");
      for (const state of [3, 7]) {
        ps(\`if (!(Test-Path -LiteralPath '\${key}')) { New-Item -Path '\${key}' -Force | Out-Null }; New-ItemProperty -LiteralPath '\${key}' -Name '\${name}' -PropertyType Binary -Value ([byte[]]@(\${state},0,0,0,0,0,0,0,0,0,0,0)) -Force | Out-Null\`);
        const disabled = autostartStatus();
        assert.equal(disabled.installed, true);
        assert.equal(disabled.disabled, true);
        assert.equal(disabled.enabled, false, 'Windows 禁用后不能仍显示已开启');
        assert.equal(installAutostart().ok, true);
        assert.equal(autostartStatus().enabled, true, '显式开启必须清除 Windows 禁用状态');
      }
      const quoted = file.replaceAll("'", "''");
      ps(\`$s=(New-Object -ComObject WScript.Shell).CreateShortcut('\${quoted}'); $s.TargetPath='C:/old-install/心语.exe'; $s.Save()\`);
      const stale = autostartStatus();
      assert.equal(stale.matchesCurrent, false);
      assert.equal(stale.enabled, false, '旧安装位置不能显示为当前实例已开启');
      assert.equal(installAutostart().ok, true);
      assert.equal(autostartStatus().target, path.join(process.env.HEARTECHO_INSTALL_ROOT, '心语.exe'));
      assert.equal(autostartStatus().enabled, true);
      assert.equal(removeAutostart().ok, true);
      assert.equal(autostartStatus().enabled, false);
    } finally {
      removeAutostart();
      if (file) ps(\`if ((Get-ItemProperty -LiteralPath '\${key}' -ErrorAction SilentlyContinue).'\${path.basename(file)}') { Remove-ItemProperty -LiteralPath '\${key}' -Name '\${path.basename(file)}' }\`);
    }
  `;
  try {
    const root = path.join(tmp, "安装目录");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "心语.exe"), "test fixture");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HEARTECHO_")));
    Object.assign(env, {
      APPDATA: path.join(tmp, "roaming"), LOCALAPPDATA: path.join(tmp, "local"),
      HEARTECHO_INSTALLED: "1", HEARTECHO_INSTALL_ROOT: root, HEARTECHO_APP_DIR: root,
      HEARTECHO_INSTANCE: "1", HEARTECHO_SETTINGS: path.join(tmp, "settings.json"),
    });
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: path.resolve(import.meta.dirname, ".."), env, encoding: "utf8", windowsHide: true, timeout: 25000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
