using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

// 识别旧安装目录或数据目录；只复制到空目录，绝不覆盖来源。
internal static class Migration
{
    internal static int CharacterCount(string dir)
    {
        string roles = Path.Combine(dir, "characters");
        if (!Directory.Exists(roles)) return 0;
        PathGuard.RejectReparseAncestors(roles);
        return Directory.GetFiles(roles, "*.json", SearchOption.TopDirectoryOnly).Length;
    }

    internal static string Describe(string dir)
    {
        string database = Path.Combine(dir, "database", "main.db");
        long bytes = File.Exists(database) ? new FileInfo(database).Length : 0;
        return CharacterCount(dir) + " 个角色；数据库 " + (bytes / 1024.0 / 1024.0).ToString("0.00") + " MB";
    }

    private static bool IsData(string dir)
    {
        return Directory.Exists(dir) && (File.Exists(Path.Combine(dir, "config.json")) ||
            File.Exists(Path.Combine(dir, "database", "main.db")) || Directory.Exists(Path.Combine(dir, "characters")));
    }

    internal static string ResolveSource(string selected)
    {
        string root = Path.GetFullPath(selected);
        if (File.Exists(root) && Path.GetExtension(root).Equals(".exe", StringComparison.OrdinalIgnoreCase)) root = Path.GetDirectoryName(root);
        PathGuard.RejectReparseAncestors(root);
        if (IsData(root) && CharacterCount(root) > 0) return root;
        var candidates = new List<string>();
        foreach (string name in new[] { "心语设置.json", "心语TB设置.json" }) {
            string configured = InstallCore.SettingsDataDir(Path.Combine(root, name));
            if (configured.Length > 0) candidates.Add(Path.GetFullPath(Path.IsPathRooted(configured) ? configured : Path.Combine(root, configured)));
        }
        string marker = Path.Combine(root, "INSTALL-EDITION.txt");
        if (File.Exists(marker)) {
            string local = Environment.GetEnvironmentVariable("LOCALAPPDATA") ?? Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (File.ReadAllText(marker).Trim() == "tb") {
                string configured = InstallCore.SettingsDataDir(Path.Combine(local, "心语TB", "心语TB设置.json"));
                candidates.Add(configured.Length == 0 ? Path.Combine(local, "心语TB", "data") : Path.GetFullPath(Path.IsPathRooted(configured) ? configured : Path.Combine(root, configured)));
            } else candidates.Add(Path.Combine(local, "心语"));
        }
        candidates.Add(Path.Combine(root, "data"));
        candidates.Add(Path.Combine(root, "dist", "data"));
        candidates.Add(Path.Combine(root, "data-export"));
        foreach (string candidate in candidates) {
            PathGuard.RejectReparseAncestors(candidate);
            if (IsData(candidate) && CharacterCount(candidate) > 0) return candidate;
        }
        throw new IOException("这里没有找到旧角色。仅有初始化配置或空数据库的目录不能导入。请选择你以前使用的心语.exe、它所在的文件夹、含角色JSON的数据目录，或完整迁移导出目录。原数据不会被修改。");
    }

    internal sealed class Prepared : IDisposable
    {
        private readonly string source;
        private readonly string destination;
        private readonly string stage;
        private bool committed;
        internal Prepared(string source, string destination, string stage) { this.source = source; this.destination = destination; this.stage = stage; }
        internal void Commit()
        {
            if (committed) throw new InvalidOperationException("旧数据已经导入");
            EnsureNotRunning(source);
            if (File.Exists(destination) || (Directory.Exists(destination) && Directory.GetFileSystemEntries(destination).Length != 0))
                throw new IOException("目标数据目录已有内容，不会覆盖");
            if (Directory.Exists(destination))
            {
                if ((File.GetAttributes(destination) & FileAttributes.ReparsePoint) != 0) throw new IOException("目标数据目录不能是链接");
                Directory.Delete(destination, false);
            }
            try { Directory.Move(stage, destination); }
            catch (IOException) { CommitByCopy(); }
            catch (UnauthorizedAccessException) { CommitByCopy(); }
            committed = true;
            string state = Path.Combine(destination, "state");
            PathGuard.RejectReparseAncestors(state);
            Directory.CreateDirectory(state);
            string receipt = Path.Combine(state, "migration-import.json");
            PathGuard.RejectReparseAncestors(receipt);
            var json = new JavaScriptSerializer();
            File.WriteAllText(receipt, json.Serialize(new {
                source = source, destination = destination,
                characters = CharacterCount(destination),
                importedAt = DateTime.UtcNow.ToString("o")
            }));
        }
        private void CommitByCopy()
        {
            // EFS加密目录、重定向用户目录等文件系统可能拒绝目录重命名。
            // 只向尚不存在的目标完整复制；失败不启动应用、不修改来源。
            if (!Directory.Exists(stage) || Directory.Exists(destination) || File.Exists(destination)) throw new IOException("无法提交导入：目标已变化或暂存目录不可用");
            try {
                CopyTree(stage, destination);
                if (CharacterCount(destination) != CharacterCount(stage)) throw new IOException("导入角色校验失败");
            } catch {
                if (Directory.Exists(destination)) Directory.Delete(destination, true);
                throw;
            }
            Directory.Delete(stage, true);
        }
        public void Dispose()
        {
            if (!committed && Directory.Exists(stage)) Directory.Delete(stage, true);
        }
    }
    private static bool SameOrChild(string candidate, string parent)
    {
        string value = Path.GetFullPath(candidate).TrimEnd(Path.DirectorySeparatorChar);
        string root = Path.GetFullPath(parent).TrimEnd(Path.DirectorySeparatorChar);
        return value.Equals(root, StringComparison.OrdinalIgnoreCase) || value.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    }

    internal static void EnsureNotRunning(string data)
    {
        string digest;
        using (SHA1 hash = SHA1.Create()) digest = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(data).ToLowerInvariant()))).Replace("-", "").ToLowerInvariant().Substring(0, 12);
        string file = Path.Combine(Path.GetTempPath(), "heartecho-" + digest + ".lock");
        if (!File.Exists(file)) return;
        try
        {
            var value = new JavaScriptSerializer().DeserializeObject(File.ReadAllText(file)) as Dictionary<string, object>;
            object pid;
            if (value == null || !value.TryGetValue("pid", out pid)) throw new InvalidDataException("锁文件无效");
            int number = Convert.ToInt32(pid);
            try { using (Process process = Process.GetProcessById(number)) if (!process.HasExited) throw new IOException("旧心语仍在运行，请先退出再导入"); }
            catch (ArgumentException) { /* 锁属于已退出的进程 */ }
        }
        catch (IOException) { throw; }
        catch (Exception error) { throw new IOException("无法确认旧数据是否正在使用，请先检查锁文件：" + file, error); }
    }

    private static void CopyTree(string source, string target)
    {
        if ((File.GetAttributes(source) & FileAttributes.ReparsePoint) != 0) throw new IOException("旧数据包含链接，请先检查：" + source);
        Directory.CreateDirectory(target);
        foreach (string item in Directory.GetFileSystemEntries(source))
        {
            FileAttributes attributes = File.GetAttributes(item);
            if ((attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("旧数据包含链接，请先检查：" + item);
            string to = Path.Combine(target, Path.GetFileName(item));
            if ((attributes & FileAttributes.Directory) != 0) CopyTree(item, to);
            else
            {
                var before = new FileInfo(item);
                long length = before.Length;
                DateTime modified = before.LastWriteTimeUtc;
                File.Copy(item, to, false);
                var after = new FileInfo(item);
                if (length != after.Length || modified != after.LastWriteTimeUtc) throw new IOException("复制时旧数据发生变化，请关闭旧程序后重试：" + item);
                using (var hash = SHA256.Create())
                using (var original = File.OpenRead(item))
                using (var copied = File.OpenRead(to))
                    if (Convert.ToBase64String(hash.ComputeHash(original)) != Convert.ToBase64String(hash.ComputeHash(copied))) throw new IOException("迁移文件校验失败，原数据已保留：" + item);
            }
        }
    }

    internal static Prepared Prepare(string source, string destination, bool exact = false, string stagingParent = null)
    {
        string from = (exact ? Path.GetFullPath(source) : ResolveSource(source)).TrimEnd(Path.DirectorySeparatorChar);
        string to = Path.GetFullPath(destination).TrimEnd(Path.DirectorySeparatorChar);
        if (String.IsNullOrEmpty(Path.GetDirectoryName(from)) || String.IsNullOrEmpty(Path.GetDirectoryName(to)))
            throw new IOException("不能将磁盘根目录用作数据导入路径");
        PathGuard.RejectReparseAncestors(from);
        PathGuard.RejectReparseAncestors(to);
        if (!Directory.Exists(from)) throw new IOException("旧数据目录不存在");
        if (String.Equals(from, to, StringComparison.OrdinalIgnoreCase)) { EnsureNotRunning(from); return null; }
        if (SameOrChild(from, to) || SameOrChild(to, from)) throw new IOException("旧数据目录和目标目录不能互相包含");
        if (!File.Exists(Path.Combine(from, "config.json")) && !Directory.Exists(Path.Combine(from, "characters")) && !Directory.Exists(Path.Combine(from, "database")))
            throw new IOException("所选目录不像心语数据目录，请选择包含 config.json、characters 或 database 的目录");
        if (File.Exists(to) || (Directory.Exists(to) && Directory.GetFileSystemEntries(to).Length != 0))
            throw new IOException("目标数据目录已有内容，不会覆盖；请先备份并选择空目录");
        if (Directory.Exists(to) && (File.GetAttributes(to) & FileAttributes.ReparsePoint) != 0) throw new IOException("目标数据目录不能是链接");
        EnsureNotRunning(from);
        string parent = String.IsNullOrWhiteSpace(stagingParent) ? Path.GetDirectoryName(to) : Path.GetFullPath(stagingParent);
        if (String.IsNullOrEmpty(parent)) throw new IOException("目标数据目录无效");
        PathGuard.RejectReparseAncestors(parent);
        Directory.CreateDirectory(parent);
        string stage = Path.Combine(parent, ".heartecho-import-" + Guid.NewGuid().ToString("N"));
        try
        {
            CopyTree(from, stage);
            EnsureNotRunning(from);
            if (CharacterCount(stage) != CharacterCount(from)) throw new IOException("导入角色数量校验失败，原数据已保留");
            return new Prepared(from, to, stage);
        }
        catch
        {
            if (Directory.Exists(stage)) Directory.Delete(stage, true);
            throw;
        }
    }

    internal static void CopyFrom(string source, string destination)
    {
        using (Prepared prepared = Prepare(source, destination)) if (prepared != null) prepared.Commit();
    }
}
