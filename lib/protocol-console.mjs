import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

// 仅处理指定协议目录启动的 node 及其专用 cmd /c launcher.bat 控制台。
// 不结束进程、不接管用户的 PowerShell/Windows Terminal，也不隐藏首次初始化窗口。
const script = String.raw`
$ErrorActionPreference = 'Stop'
$targetId = [int]$env:HEARTECHO_CONSOLE_PID
$directory = [IO.Path]::GetFullPath($env:HEARTECHO_CONSOLE_DIR).TrimEnd('\')
$process = Get-CimInstance Win32_Process -Filter "ProcessId = $targetId"
if (!$process -or $process.Name -ine 'node.exe') { @{ok=$false; hidden=$false; reason='not-node'} | ConvertTo-Json -Compress; exit }
$command = [string]$process.CommandLine
$direct = $false
foreach ($entry in @('index.mjs','main.mjs','app.mjs','index.js','main.js')) {
  $pattern = '(?i)(?:^|[\s"''])' + [regex]::Escape((Join-Path $directory $entry)) + '(?:$|[\s"''])'
  if ($command.Replace('/','\') -match $pattern) { $direct = $true }
}
$parent = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $process.ParentProcessId)
$dedicated = $false
if ($parent -and $parent.Name -ieq 'cmd.exe' -and $parent.CommandLine -match '(?i)\s/c\s') {
  foreach ($entry in @('launcher.bat','start.bat')) {
    $pattern = '(?i)(?:^|[\s"''])' + [regex]::Escape((Join-Path $directory $entry)) + '(?:$|[\s"''])'
    if ($parent.CommandLine.Replace('/','\') -match $pattern) { $dedicated = $true }
  }
}
if (!$direct -and !$dedicated) { @{ok=$false; hidden=$false; reason='unverified-entry'} | ConvertTo-Json -Compress; exit }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ProtocolConsole {
 [DllImport("kernel32.dll")] public static extern bool FreeConsole();
 [DllImport("kernel32.dll")] public static extern bool AttachConsole(uint id);
 [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint id);
}
'@
[void][ProtocolConsole]::FreeConsole()
if (![ProtocolConsole]::AttachConsole([uint32]$targetId)) { @{ok=($env:HEARTECHO_CONSOLE_ACTION -ne 'show'); hidden=$true; reason='no-console'} | ConvertTo-Json -Compress; exit }
$window = [ProtocolConsole]::GetConsoleWindow()
# 共享终端不属于专用启动器，不能隐藏。
$consoleOwner = [uint32]0
[void][ProtocolConsole]::GetWindowThreadProcessId($window, [ref]$consoleOwner)
$owner = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $consoleOwner)
$allowed = $dedicated -or ($direct -and $owner -and $owner.Name -ieq 'conhost.exe' -and $owner.ParentProcessId -eq $targetId)
if (!$allowed) {
 [void][ProtocolConsole]::FreeConsole()
 @{ok=$false; hidden=$false; reason='shared-console'} | ConvertTo-Json -Compress; exit
}
$visibleBefore = [ProtocolConsole]::IsWindowVisible($window)
$show = $env:HEARTECHO_CONSOLE_ACTION -eq 'show'
[void][ProtocolConsole]::ShowWindow($window, $(if ($show) {5} else {0}))
$visible = [ProtocolConsole]::IsWindowVisible($window)
[void][ProtocolConsole]::FreeConsole()
@{ok=($visible -eq $show); hidden=(!$visible); changed=($visibleBefore -ne $visible)} | ConvertTo-Json -Compress
`;

export async function setProtocolConsole({ pid, dir, show = false }) {
  if (process.platform !== "win32" || !Number.isInteger(pid) || pid <= 0 || !dir) return { ok: false, hidden: false, reason: "unavailable" };
  try {
    const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      windowsHide: true, timeout: 12000, maxBuffer: 8192,
      env: { ...process.env, HEARTECHO_CONSOLE_PID: String(pid), HEARTECHO_CONSOLE_DIR: dir, HEARTECHO_CONSOLE_ACTION: show ? "show" : "hide" },
    });
    return JSON.parse(stdout.trim());
  } catch { return { ok: false, hidden: false, reason: "console-unavailable" }; }
}
