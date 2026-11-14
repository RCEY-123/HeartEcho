using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Windows.Forms;
using Microsoft.Win32;

// 安装器只安装本项目与 Node；QQ 协议端由用户自行下载并选择目录。
internal static class Installer
{
#if TB_EDITION
    private const string Edition = "tb";
    private const string DisplayName = "领航员终端";
    private const string ProgramDirectory = "NavigatorTerminal";
    private const string LauncherName = "领航员终端.exe";
#else
    private const string Edition = "generic";
    private const string DisplayName = "心语";
    private const string ProgramDirectory = "HeartEcho";
    private const string LauncherName = "心语.exe";
#endif

    private static string Local { get { return Environment.GetEnvironmentVariable("LOCALAPPDATA") ?? Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData); } }
    private static string Roaming { get { return Environment.GetEnvironmentVariable("APPDATA") ?? Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData); } }
    private static string DefaultDestination {
        get {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(UninstallKey, false)) {
                string registered = key == null ? "" : Convert.ToString(key.GetValue("InstallLocation", ""));
                if (registered.Length > 0 && File.Exists(Path.Combine(registered, "INSTALL-EDITION.txt")) && File.ReadAllText(Path.Combine(registered, "INSTALL-EDITION.txt")).Trim() == Edition) return registered;
            }
            return Path.Combine(Local, "Programs", ProgramDirectory);
        }
    }
    private static bool Updating;
    private static string DefaultData { get { return Edition == "tb" ? Path.Combine(Local, "心语TB", "data") : Path.Combine(Local, "心语"); } }
    private static string UninstallKey { get { return @"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + ProgramDirectory; } }

    private static string Option(string[] args, string prefix)
    {
        foreach (string arg in args) if (arg.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return arg.Substring(prefix.Length);
        return "";
    }
    private static bool Has(string[] args, string flag) { return Array.Exists(args, item => String.Equals(item, flag, StringComparison.OrdinalIgnoreCase)); }

    private static void Shortcut(string file, string target, string arguments)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(file));
        Type shellType = Type.GetTypeFromProgID("WScript.Shell");
        if (shellType == null) throw new IOException("无法创建 Windows 快捷方式");
        dynamic shell = Activator.CreateInstance(shellType);
        dynamic link = shell.CreateShortcut(file);
        if (File.Exists(file) && !String.Equals(Path.GetFullPath(Convert.ToString(link.TargetPath)), Path.GetFullPath(target), StringComparison.OrdinalIgnoreCase))
            throw new IOException("快捷方式已指向其他程序，请先处理：" + file);
        link.TargetPath = target;
        link.Arguments = arguments;
        link.WorkingDirectory = Path.GetDirectoryName(target);
        link.Description = DisplayName;
        link.Save();
    }

    private static void RemoveOwnedShortcut(string file, string target)
    {
        if (!File.Exists(file)) return;
        Type shellType = Type.GetTypeFromProgID("WScript.Shell");
        if (shellType == null) throw new IOException("无法检查现有开机快捷方式");
        dynamic shell = Activator.CreateInstance(shellType);
        dynamic link = shell.CreateShortcut(file);
        if (String.Equals(Path.GetFullPath(Convert.ToString(link.TargetPath)), Path.GetFullPath(target), StringComparison.OrdinalIgnoreCase)) File.Delete(file);
    }

    private static string ReadLicenses()
    {
        var content = new System.Text.StringBuilder();
        using (Stream input = Assembly.GetExecutingAssembly().GetManifestResourceStream("heartecho.payload"))
        {
            if (input == null) throw new IOException("安装包缺少许可文件");
            using (var zip = new ZipArchive(input, ZipArchiveMode.Read))
            {
                foreach (string name in new[] { "app/LICENSE", "runtime/Node-LICENSE.txt", "app/EXTENSIONS.md", "app/EXTENSION-AUTHORS.txt", "app/NOTICE" })
                {
                    // .NET Framework 的 CreateFromDirectory 在 Windows 可能写入反斜杠。
                    ZipArchiveEntry entry = zip.GetEntry(name) ?? zip.GetEntry(name.Replace('/', '\\'));
                    if (entry == null) throw new IOException("安装包缺少许可或来源说明：" + name);
                    using (var reader = new StreamReader(entry.Open())) content.AppendLine("===== " + name + " =====").AppendLine(reader.ReadToEnd()).AppendLine();
                }
            }
        }
        return content.ToString();
    }

    private static void ShowLicenses(IWin32Window owner)
    {
        using (var view = new Form { Text = "许可与来源", Width = 850, Height = 650, StartPosition = FormStartPosition.CenterParent })
        {
            view.Controls.Add(new TextBox { Dock = DockStyle.Fill, Multiline = true, ScrollBars = ScrollBars.Both, WordWrap = false, ReadOnly = true, Text = ReadLicenses() });
            view.ShowDialog(owner);
        }
    }

    private static string ReadDataDir(string target)
    {
        string settings = ReadSettingsFile(target);
        string data = InstallCore.SettingsDataDir(settings);
        if (data.Length == 0) {
            if (File.Exists(Path.Combine(target, "INSTALL-EDITION.txt")) && Directory.Exists(DefaultData)) return DefaultData;
            return Path.Combine(target, "data");
        }
        return Path.IsPathRooted(data) ? Path.GetFullPath(data) : Path.GetFullPath(Path.Combine(target, data));
    }

    private static string LocalSettingsFile(string target) { return Path.Combine(target, Edition == "tb" ? "心语TB设置.json" : "心语设置.json"); }
    private static string ReadSettingsFile(string target) {
        string localFile = LocalSettingsFile(target);
        if (File.Exists(localFile) || Edition != "tb" || !File.Exists(Path.Combine(target, "INSTALL-EDITION.txt"))) return localFile;
        return Path.Combine(Local, "心语TB", "心语TB设置.json");
    }

    private static string ReadInstancesHome(string target)
    {
        string settings = ReadSettingsFile(target);
        string home = Environment.GetEnvironmentVariable("HEARTECHO_INSTANCES_HOME");
        if (String.IsNullOrWhiteSpace(home)) home = InstallCore.SettingsString(settings, "instancesHome");
        if (String.IsNullOrWhiteSpace(home)) return target;
        return Path.GetFullPath(Path.IsPathRooted(home) ? home : Path.Combine(target, home));
    }

    private static string EmbeddedManifest()
    {
        using (Stream input = Assembly.GetExecutingAssembly().GetManifestResourceStream("heartecho.payload"))
        {
            if (input == null) throw new IOException("卸载程序缺少文件清单");
            using (var zip = new ZipArchive(input, ZipArchiveMode.Read))
            {
                var entry = zip.GetEntry("SHA256SUMS.txt");
                if (entry == null) throw new IOException("卸载程序缺少文件清单");
                using (var reader = new StreamReader(entry.Open())) return reader.ReadToEnd();
            }
        }
    }

    private static bool SameFile(string a, string b)
    {
        using (SHA256 hash = SHA256.Create())
        using (FileStream one = File.OpenRead(a))
        using (FileStream two = File.OpenRead(b))
            return Convert.ToBase64String(hash.ComputeHash(one)) == Convert.ToBase64String(hash.ComputeHash(two));
    }

    private static void CheckRegistration(string target)
    {
        using (RegistryKey key = Registry.CurrentUser.OpenSubKey(UninstallKey, false))
        {
            string previous = key == null ? "" : Convert.ToString(key.GetValue("InstallLocation", ""));
            if (previous.Length > 0 && !String.Equals(Path.GetFullPath(previous), Path.GetFullPath(target), StringComparison.OrdinalIgnoreCase))
                throw new IOException("此版本已经登记在其他安装目录，请先处理已有安装。");
        }
    }

    private static void Register(string target)
    {
        using (RegistryKey key = Registry.CurrentUser.CreateSubKey(UninstallKey))
        {
            key.SetValue("DisplayName", DisplayName);
            key.SetValue("InstallLocation", target);
            key.SetValue("DisplayIcon", Path.Combine(target, LauncherName));
            key.SetValue("Publisher", "HeartEcho contributors");
            key.SetValue("UninstallString", "\"" + Path.Combine(target, "卸载.exe") + "\" --uninstall");
            key.SetValue("NoModify", 1, RegistryValueKind.DWord);
            key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        }
    }

    private static void RemoveRegistration(string target)
    {
        using (RegistryKey key = Registry.CurrentUser.OpenSubKey(UninstallKey, false))
        {
            string previous = key == null ? "" : Convert.ToString(key.GetValue("InstallLocation", ""));
            if (previous.Length == 0 || !String.Equals(Path.GetFullPath(previous), Path.GetFullPath(target), StringComparison.OrdinalIgnoreCase)) return;
        }
        Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false);
    }

    private static void Install(string target, bool desktop, bool startMenu, bool autostart, bool launch, bool register, string importSource)
    {
        using (OperationLock.Acquire(target))
        {
            if (register) CheckRegistration(target);
            string dataDir = ReadDataDir(target);
            // 旧版默认 AppData 自动迁到安装盘；明确的自定义位置保持原样。
            string relocation = "";
            if (String.IsNullOrWhiteSpace(importSource) && File.Exists(Path.Combine(target, "INSTALL-EDITION.txt")) &&
                String.Equals(Path.GetFullPath(dataDir).TrimEnd(Path.DirectorySeparatorChar), Path.GetFullPath(DefaultData).TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase) && Directory.Exists(dataDir)) {
                relocation = dataDir;
                dataDir = Path.Combine(target, "data");
                if (Directory.Exists(dataDir) && Directory.GetFileSystemEntries(dataDir).Length > 0)
                    dataDir = Path.Combine(target, "data-migrated-" + Guid.NewGuid().ToString("N").Substring(0, 10));
            }
            bool redirectImport = false;
            if (!String.IsNullOrWhiteSpace(importSource)) {
                importSource = Migration.ResolveSource(importSource);
                if (!String.Equals(Path.GetFullPath(importSource).TrimEnd(Path.DirectorySeparatorChar), Path.GetFullPath(dataDir).TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase)
                    && (File.Exists(dataDir) || (Directory.Exists(dataDir) && Directory.GetFileSystemEntries(dataDir).Length > 0))) {
                    dataDir = dataDir.TrimEnd(Path.DirectorySeparatorChar) + "-import-" + Guid.NewGuid().ToString("N").Substring(0, 10);
                    redirectImport = true;
                }
            }
            using (OperationLock.Acquire(dataDir))
            using (OperationLock oldLock = relocation.Length > 0 ? OperationLock.Acquire(relocation) : null)
            // 暂存放在程序目录外，避免首次导入尚未安装便把目标程序目录变成非空。
            using (Migration.Prepared pending = relocation.Length > 0 ? Migration.Prepare(relocation, dataDir, true, Path.GetDirectoryName(target)) : String.IsNullOrWhiteSpace(importSource) ? null : Migration.Prepare(importSource, dataDir, false, Path.GetDirectoryName(target)))
                InstallPrepared(target, desktop, startMenu, autostart, launch, register, dataDir, pending, redirectImport, relocation);
        }
    }

    private static void InstallPrepared(string target, bool desktop, bool startMenu, bool autostart, bool launch, bool register, string dataDir, Migration.Prepared pending, bool redirectImport, string relocation)
    {
        string previousVersion = ReadInstalledVersion(target);
        string previousSettings = ReadSettingsFile(target);
        string archive = Path.GetTempFileName();
        try
        {
            using (Stream input = Assembly.GetExecutingAssembly().GetManifestResourceStream("heartecho.payload"))
            {
                if (input == null) throw new IOException("安装包缺少程序文件");
                using (FileStream output = new FileStream(archive, FileMode.Truncate, FileAccess.Write, FileShare.None)) input.CopyTo(output);
            }
            InstallCore.Install(archive, target, Edition, dataDir, null, Assembly.GetExecutingAssembly().Location, ReadInstancesHome(target));
        }
        finally { File.Delete(archive); }
        if (pending != null)
        {
            try { pending.Commit(); }
            catch (Exception error) { throw new IOException("程序文件已安装，但旧数据导入失败；原数据未删除。请检查后重试：" + error.Message, error); }
        }
        {
            string settingsFile = LocalSettingsFile(target);
            PathGuard.RejectReparseAncestors(settingsFile);
            var json = new System.Web.Script.Serialization.JavaScriptSerializer();
            var settings = File.Exists(previousSettings) ? json.DeserializeObject(File.ReadAllText(previousSettings)) as System.Collections.Generic.Dictionary<string, object> : null;
            if (settings == null) settings = new System.Collections.Generic.Dictionary<string, object>();
            settings["dataDir"] = dataDir;
            if (relocation.Length > 0) {
                string oldLog = InstallCore.SettingsString(previousSettings, "logDir");
                if (oldLog.Length == 0 || String.Equals(Path.GetFullPath(Path.IsPathRooted(oldLog) ? oldLog : Path.Combine(target, oldLog)), Path.Combine(relocation, "logs"), StringComparison.OrdinalIgnoreCase) ||
                    (Edition == "tb" && String.Equals(oldLog, Path.Combine(Local, "心语TB", "logs"), StringComparison.OrdinalIgnoreCase))) settings["logDir"] = Path.Combine(dataDir, "logs");
                settings["previousDataDir"] = relocation;
                Directory.CreateDirectory(Path.Combine(dataDir, "state"));
                File.WriteAllText(Path.Combine(dataDir, "state", "storage-migration.json"), json.Serialize(new { source = relocation, destination = dataDir, verified = true, sourceRetained = true }));
            }
            Directory.CreateDirectory(Path.GetDirectoryName(settingsFile));
            string temporary = settingsFile + ".import-" + Guid.NewGuid().ToString("N");
            File.WriteAllText(temporary, json.Serialize(settings));
            if (File.Exists(settingsFile)) File.Replace(temporary, settingsFile, settingsFile + ".before-storage-" + DateTime.Now.ToString("yyyyMMddHHmmssfff"));
            else File.Move(temporary, settingsFile);
        }
        string launcher = Path.Combine(target, LauncherName);
        string menu = Path.Combine(Roaming, "Microsoft", "Windows", "Start Menu", "Programs");
        if (desktop) Shortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), DisplayName + ".lnk"), launcher, "");
        if (startMenu) Shortcut(Path.Combine(menu, DisplayName + ".lnk"), launcher, "");
        string startup = Path.Combine(menu, "Startup", Edition == "tb" ? "领航员终端.lnk" : "心语机器人.lnk");
        if (!Updating) {
            if (autostart) Shortcut(startup, launcher, "--tray");
            else RemoveOwnedShortcut(startup, launcher);
        }
        if (register) Register(target);
        string installedVersion = ReadInstalledVersion(target);
        if (previousVersion.Length > 0 && previousVersion != installedVersion) {
            string state = Path.Combine(dataDir, "state");
            PathGuard.RejectReparseAncestors(state);
            Directory.CreateDirectory(state);
            string receipt = Path.Combine(state, "update-install.json");
            PathGuard.RejectReparseAncestors(receipt);
            var json = new System.Web.Script.Serialization.JavaScriptSerializer();
            File.WriteAllText(receipt, json.Serialize(new { fromVersion = previousVersion, version = installedVersion }));
        }
        if (launch) Process.Start(new ProcessStartInfo(launcher) { UseShellExecute = true, WorkingDirectory = target });
    }

    private static string ReadInstalledVersion(string target) {
        string file = Path.Combine(target, "VERSION.json");
        if (!File.Exists(file)) return "";
        var data = new System.Web.Script.Serialization.JavaScriptSerializer().DeserializeObject(File.ReadAllText(file)) as System.Collections.Generic.Dictionary<string, object>;
        object version;
        return data != null && data.TryGetValue("version", out version) ? Convert.ToString(version) : "";
    }

    private static string DataRemovalRoot(string target)
    {
        string actual = Path.GetFullPath(ReadDataDir(target)).TrimEnd(Path.DirectorySeparatorChar);
        Migration.EnsureNotRunning(actual);
        string installData = Path.Combine(Path.GetFullPath(target), "data").TrimEnd(Path.DirectorySeparatorChar);
        if (String.Equals(actual, installData, StringComparison.OrdinalIgnoreCase)) {
            PathGuard.RejectReparseAncestors(actual);
            if (Directory.Exists(actual)) CheckDataTree(actual);
            return actual;
        }
        string expected = Path.GetFullPath(DefaultData).TrimEnd(Path.DirectorySeparatorChar);
        if (!String.Equals(actual, expected, StringComparison.OrdinalIgnoreCase))
            throw new IOException("使用了自定义数据目录，卸载器不会自动删除；请自行检查：" + actual);
        string root = Edition == "tb" ? Path.GetDirectoryName(expected) : expected;
        PathGuard.RejectReparseAncestors(root);
        if (String.IsNullOrEmpty(root) || !String.Equals(Path.GetDirectoryName(root), Path.GetFullPath(Local).TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase))
            throw new IOException("默认数据目录不符合预期，不能自动删除");
        string install = Path.GetFullPath(target).TrimEnd(Path.DirectorySeparatorChar);
        if (String.Equals(root, install, StringComparison.OrdinalIgnoreCase) || install.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || root.StartsWith(install + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new IOException("数据目录与安装目录重叠，不能自动删除；请手动备份并检查");
        if (Directory.Exists(root)) CheckDataTree(root);
        return root;
    }

    private static void CheckDataTree(string directory)
    {
        if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) throw new IOException("数据目录包含链接或重解析点，不能自动删除：" + directory);
        foreach (string entry in Directory.GetFileSystemEntries(directory))
        {
            FileAttributes attributes = File.GetAttributes(entry);
            if ((attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("数据目录包含链接或重解析点，不能自动删除：" + entry);
            if ((attributes & FileAttributes.Directory) != 0) CheckDataTree(entry);
        }
    }

    private static void Uninstall(string target, bool register, bool deleteData)
    {
        using (OperationLock.Acquire(target))
        using (OperationLock.Acquire(ReadDataDir(target))) UninstallLocked(target, register, deleteData);
    }

    private static void UninstallLocked(string target, bool register, bool deleteData)
    {
        string dataRemoval = deleteData ? DataRemovalRoot(target) : "";
        string uninstaller = Path.Combine(target, "卸载.exe");
        string self = Assembly.GetExecutingAssembly().Location;
        if (String.Equals(Path.GetFullPath(uninstaller), Path.GetFullPath(self), StringComparison.OrdinalIgnoreCase)) throw new IOException("卸载器需要从临时位置运行");
        if (File.Exists(uninstaller) && !SameFile(uninstaller, self)) throw new IOException("卸载程序已变化，请保留并手动处理");
        string manifest = EmbeddedManifest();
        var kept = UninstallCore.Remove(target, Edition, manifest);
        if (kept.Count > 0) throw new IOException("以下已修改或不可删除的文件已保留：\n" + String.Join("\n", kept.ToArray()));
        string launcher = Path.Combine(target, LauncherName);
        string menu = Path.Combine(Roaming, "Microsoft", "Windows", "Start Menu", "Programs");
        RemoveOwnedShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), DisplayName + ".lnk"), launcher);
        RemoveOwnedShortcut(Path.Combine(menu, DisplayName + ".lnk"), launcher);
        RemoveOwnedShortcut(Path.Combine(menu, "Startup", Edition == "tb" ? "领航员终端.lnk" : "心语机器人.lnk"), launcher);
        if (deleteData && Directory.Exists(dataRemoval))
        {
            Migration.EnsureNotRunning(ReadDataDir(target));
            CheckDataTree(dataRemoval);
            Directory.Delete(dataRemoval, true);
        }
        if (register) RemoveRegistration(target);
        if (File.Exists(uninstaller)) File.Delete(uninstaller);
        UninstallCore.FinalizeRemoval(target, Edition, manifest);
        try { Directory.Delete(target, false); } catch (IOException) { /* 用户设置、协议端或备份需要保留 */ }
    }

    private static string QuoteArgument(string value)
    {
        var result = new System.Text.StringBuilder("\"");
        int slashes = 0;
        foreach (char ch in value)
        {
            if (ch == '\\') { slashes++; continue; }
            if (ch == '"') { result.Append('\\', slashes * 2 + 1); result.Append('"'); }
            else { result.Append('\\', slashes); result.Append(ch); }
            slashes = 0;
        }
        result.Append('\\', slashes * 2).Append('"');
        return result.ToString();
    }

    private static void LaunchUninstaller(string target, bool deleteData)
    {
        string helper = Path.Combine(Path.GetTempPath(), "heartecho-uninstall-" + Guid.NewGuid().ToString("N") + ".exe");
        File.Copy(Assembly.GetExecutingAssembly().Location, helper, false);
        try
        {
            var start = new ProcessStartInfo(helper, "--uninstall-helper " + QuoteArgument("--dir=" + target) + " --parent=" + Process.GetCurrentProcess().Id + (deleteData ? " --delete-data --confirm-delete-data" : ""));
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            if (Process.Start(start) == null) throw new IOException("无法启动卸载助手");
        }
        catch { File.Delete(helper); throw; }
    }

    private static void RemoveTemporaryHelperAfterExit()
    {
        string self = Path.GetFullPath(Assembly.GetExecutingAssembly().Location);
        string temp = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar);
        string name = Path.GetFileName(self);
        if (!String.Equals(Path.GetDirectoryName(self), temp, StringComparison.OrdinalIgnoreCase) ||
            !name.StartsWith("heartecho-uninstall-", StringComparison.Ordinal) || !name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) return;
        // 单一 PowerShell 进程只删除该助手自身；路径和进程号通过环境变量传递，不拼接进脚本。
        string script = "$p=$env:HEARTECHO_UNINSTALL_SELF; $id=[int]$env:HEARTECHO_UNINSTALL_PID; Wait-Process -Id $id -ErrorAction SilentlyContinue; Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue";
        string encoded = Convert.ToBase64String(System.Text.Encoding.Unicode.GetBytes(script));
        try
        {
            var start = new ProcessStartInfo("powershell.exe", "-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand " + encoded);
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.EnvironmentVariables["HEARTECHO_UNINSTALL_SELF"] = self;
            start.EnvironmentVariables["HEARTECHO_UNINSTALL_PID"] = Process.GetCurrentProcess().Id.ToString();
            Process.Start(start);
        }
        catch { /* 临时文件可在之后手动删除，不影响用户数据 */ }
    }

    [STAThread]
    private static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        if (Has(args, "--verify-resources"))
        {
            try { return ReadLicenses().Length > 0 && EmbeddedManifest().Length > 0 ? 0 : 1; }
            catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
        }
        string target = Option(args, "--dir=");
        if (target.Length == 0) target = DefaultDestination;
        Updating = Has(args, "--update");
        if (Updating && (Option(args, "--dir=").Length == 0 || !File.Exists(Path.Combine(target, "INSTALL-EDITION.txt")) || File.ReadAllText(Path.Combine(target, "INSTALL-EDITION.txt")).Trim() != Edition)) return 2;
        string waitPid = Option(args, "--wait-pid=");
        if (waitPid.Length > 0) {
            int pid;
            if (!Int32.TryParse(waitPid, out pid) || pid <= 0 || pid == Process.GetCurrentProcess().Id) return 2;
            try {
                try { using (Process parent = Process.GetProcessById(pid)) if (!parent.WaitForExit(60000)) throw new IOException("心语尚未退出，请关闭当前实例后重新运行更新包"); }
                catch (ArgumentException) { /* 应用已正常退出 */ }
                System.Threading.Thread.Sleep(500); // 等启动器释放程序文件。
            } catch (Exception error) {
                if (Has(args, "--notify-errors")) MessageBox.Show(error.Message, DisplayName, MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }
        bool helper = Has(args, "--uninstall-helper");
        bool direct = Has(args, "--uninstall-direct");
        if (helper || direct)
        {
            if (Option(args, "--dir=").Length == 0 || (direct && (!Has(args, "--silent") || !Has(args, "--accept-uninstall")))) return 2;
            if (Has(args, "--delete-data") && !Has(args, "--confirm-delete-data")) return 2;
            try
            {
                int parent;
                if (helper && Int32.TryParse(Option(args, "--parent="), out parent) && parent > 0)
                {
                    try { using (Process process = Process.GetProcessById(parent)) if (!process.WaitForExit(15000)) throw new IOException("卸载入口仍在运行，请重新尝试"); }
                    catch (ArgumentException) { /* 卸载入口已经退出 */ }
                }
                bool deleteData = Has(args, "--delete-data");
                Uninstall(Path.GetFullPath(target), !Has(args, "--no-register"), deleteData);
                if (!Has(args, "--silent")) MessageBox.Show(deleteData ? "卸载完成。已删除默认数据目录，协议端和安装备份已保留。" : "卸载完成。用户数据、协议端和安装备份已保留。", DisplayName);
                return 0;
            }
            catch (Exception error)
            {
                if (!Has(args, "--silent")) MessageBox.Show("卸载未完成：" + error.Message, DisplayName, MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
            finally { if (helper) RemoveTemporaryHelperAfterExit(); }
        }
        if (Has(args, "--uninstall") || String.Equals(Path.GetFileName(Assembly.GetExecutingAssembly().Location), "卸载.exe", StringComparison.OrdinalIgnoreCase))
        {
            target = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            DialogResult choice = MessageBox.Show("卸载 " + DisplayName + "？\n\n是：保留用户数据（推荐）\n否：删除默认用户数据\n取消：不卸载\n\n协议端和安装备份会保留。", DisplayName, MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question);
            if (choice == DialogResult.Cancel) return 1;
            bool deleteData = choice == DialogResult.No;
            if (deleteData)
            {
                try
                {
                    string data = DataRemovalRoot(target);
                    if (MessageBox.Show("将永久删除以下目录中的角色、记忆、设置和备份：\n" + data + "\n\n确定删除？", DisplayName, MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return 1;
                }
                catch (Exception error) { MessageBox.Show(error.Message, DisplayName, MessageBoxButtons.OK, MessageBoxIcon.Error); return 1; }
            }
            try { LaunchUninstaller(target, deleteData); return 0; }
            catch (Exception error) { MessageBox.Show("无法启动卸载：" + error.Message, DisplayName, MessageBoxButtons.OK, MessageBoxIcon.Error); return 1; }
        }
        if (Has(args, "--silent"))
        {
            if (!Has(args, "--accept-license")) return 2;
            try { Install(Path.GetFullPath(target), Has(args, "--desktop"), Has(args, "--start-menu"), Has(args, "--autostart"), Has(args, "--launch"), Has(args, "--register"), Option(args, "--import-dir=")); return 0; }
            catch (Exception error) { Console.Error.WriteLine(error.Message); if (Has(args, "--notify-errors")) MessageBox.Show("更新未完成，用户数据已保留：" + error.Message, DisplayName, MessageBoxButtons.OK, MessageBoxIcon.Error); return 1; }
        }
        using (var form = new Form { Text = DisplayName + " 安装（开发预览）", Width = 660, Height = 510, StartPosition = FormStartPosition.CenterScreen, FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false })
        {
            var intro = new Label { Left = 24, Top = 20, Width = 600, Height = 48, Text = "数据、日志和备份默认放在下方安装目录。升级会搬迁旧版默认 AppData 数据并保留原副本；自定义目录不变。" };
            var input = new TextBox { Left = 24, Top = 74, Width = 490, Text = target };
            var browse = new Button { Left = 520, Top = 72, Width = 100, Text = "选择目录" };
            browse.Click += (s, e) => { using (var dialog = new FolderBrowserDialog()) if (dialog.ShowDialog(form) == DialogResult.OK) input.Text = dialog.SelectedPath; };
            var desktop = new CheckBox { Left = 24, Top = 115, Width = 550, Text = "创建桌面快捷方式", Checked = true };
            var menu = new CheckBox { Left = 24, Top = 145, Width = 550, Text = "创建开始菜单快捷方式", Checked = true };
            string existingStartup = Path.Combine(Roaming, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", Edition == "tb" ? "领航员终端.lnk" : "心语机器人.lnk");
            var startup = new CheckBox { Left = 24, Top = 175, Width = 550, Text = "登录 Windows 后自动在托盘启动（可在面板关闭）", Checked = !File.Exists(Path.Combine(target, "INSTALL-EDITION.txt")) || File.Exists(existingStartup) };
            var import = new CheckBox { Left = 24, Top = 211, Width = 590, Text = "导入旧角色、对话、记忆和生命计划（自动识别目录）" };
            string nearby = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            string old = Path.Combine(nearby, "data");
            if (!Directory.Exists(old)) old = Path.Combine(nearby, "dist", "data");
            if (Directory.Exists(old)) import.Text = "检测到旧数据；勾选后复制导入（不会删除原目录）";
            var oldData = new TextBox { Left = 24, Top = 240, Width = 490, Text = Directory.Exists(old) ? old : "" };
            var chooseOld = new Button { Left = 520, Top = 238, Width = 100, Text = "选择旧心语" };
            chooseOld.Click += (s, e) => { using (var dialog = new FolderBrowserDialog()) if (dialog.ShowDialog(form) == DialogResult.OK) { oldData.Text = dialog.SelectedPath; import.Checked = true; } };
            var chooseExe = new Button { Left = 24, Top = 268, Width = 115, Height = 24, Text = "选择旧心语.exe" };
            chooseExe.Click += (s, e) => { using (var dialog = new OpenFileDialog { Filter = "旧心语程序 (*.exe)|*.exe", CheckFileExists = true }) if (dialog.ShowDialog(form) == DialogResult.OK) { oldData.Text = dialog.FileName; import.Checked = true; } };
            var migrationHint = new Label { Left = 148, Top = 270, Width = 475, Height = 23, Text = "选旧.exe也能识别数据；会显示角色数量供确认。" };
            var terms = new CheckBox { Left = 24, Top = 295, Width = 600, Height = 42, Text = "我已阅读并接受心语 AGPL、Node 及随附扩展的许可与来源说明。" };
            var licenses = new LinkLabel { Left = 24, Top = 340, Width = 570, Text = "查看许可与第三方扩展来源" };
            licenses.Click += (s, e) => { try { ShowLicenses(form); } catch (Exception error) { MessageBox.Show(form, error.Message, DisplayName); } };
            var progress = new Label { Left = 24, Top = 370, Width = 590, Height = 20, Text = "" };
            var go = new Button { Left = 400, Top = 400, Width = 105, Height = 32, Text = "安装" };
            var cancel = new Button { Left = 515, Top = 400, Width = 105, Height = 32, Text = "取消", DialogResult = DialogResult.Cancel };
            int result = 1;
            go.Click += async (s, e) => {
                if (!terms.Checked) { MessageBox.Show(form, "请先确认许可说明。", DisplayName); return; }
                if (import.Checked && String.IsNullOrWhiteSpace(oldData.Text)) { MessageBox.Show(form, "请选择旧心语的程序目录、数据目录或完整迁移导出目录。", DisplayName); return; }
                if (startup.Checked && MessageBox.Show(form, "登录 Windows 后会自动在托盘启动。可取消勾选，也可稍后在面板关闭。继续安装？", DisplayName, MessageBoxButtons.YesNo) != DialogResult.Yes) return;
                string selectedTarget;
                try { selectedTarget = Path.GetFullPath(input.Text); }
                catch (Exception error) { MessageBox.Show(form, "安装目录无效：" + error.Message, DisplayName); return; }
                bool desktopOption = desktop.Checked, menuOption = menu.Checked, startupOption = startup.Checked;
                string importOption = import.Checked ? oldData.Text : "";
                if (import.Checked) {
                    try {
                        importOption = Migration.ResolveSource(importOption);
                        string currentData = ReadDataDir(selectedTarget);
                        string action = String.Equals(Path.GetFullPath(importOption).TrimEnd(Path.DirectorySeparatorChar), Path.GetFullPath(currentData).TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase)
                            ? "这是当前使用的数据，将原地保留，不重复复制。"
                            : "将完整复制角色、对话、记忆、生命计划和图片。若当前已有数据，将另建目录并切换到导入数据，现有数据仍保留。";
                        if (MessageBox.Show(form, "识别到旧数据：\n" + importOption + "\n" + Migration.Describe(importOption) + "\n\n" + action + "\n旧来源不会删除。确认导入？", DisplayName, MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
                    } catch (Exception error) { MessageBox.Show(form, error.Message, DisplayName); return; }
                }
                go.Enabled = cancel.Enabled = browse.Enabled = chooseOld.Enabled = chooseExe.Enabled = false;
                form.ControlBox = false;
                progress.Text = "正在校验文件、备份并安装，请稍候…";
                try {
                    var completion = new System.Threading.Tasks.TaskCompletionSource<bool>();
                    var worker = new System.Threading.Thread(() => {
                        try { Install(selectedTarget, desktopOption, menuOption, startupOption, true, true, importOption); completion.SetResult(true); }
                        catch (Exception error) { completion.SetException(error); }
                    });
                    worker.SetApartmentState(System.Threading.ApartmentState.STA);
                    worker.Start();
                    await completion.Task;
                    string actualData = ReadDataDir(selectedTarget);
                    string doneMessage = "安装完成。当前数据目录：\n" + actualData + "\n" + Migration.Describe(actualData);
                    string retained = InstallCore.SettingsString(LocalSettingsFile(selectedTarget), "previousDataDir");
                    if (retained.Length > 0) doneMessage += "\n旧副本保留在：" + retained + "\n确认角色、记忆和图片正常后，可手动删除旧副本释放空间。";
                    if (importOption.Length > 0) doneMessage += "\n旧QQ聊天仍保留在原QQ会话作用域，不会伪装成新的应用内聊天。可在记忆、数字生命及会话记录中查看。";
                    else doneMessage += "\n新用户请按向导接入自己的API Key。";
                    MessageBox.Show(form, doneMessage, DisplayName);
                    result = 0; form.Close();
                } catch (Exception error) {
                    MessageBox.Show(form, "安装失败：" + error.Message, DisplayName, MessageBoxButtons.OK, MessageBoxIcon.Error);
                    progress.Text = "安装未完成，请检查提示后重试。";
                    go.Enabled = cancel.Enabled = browse.Enabled = chooseOld.Enabled = chooseExe.Enabled = true;
                    form.ControlBox = true;
                }
            };
            form.Controls.AddRange(new Control[] { intro, input, browse, desktop, menu, startup, import, oldData, chooseOld, chooseExe, migrationHint, terms, licenses, progress, go, cancel });
            form.AcceptButton = go; form.CancelButton = cancel;
            Application.Run(form);
            return result;
        }
    }
}
