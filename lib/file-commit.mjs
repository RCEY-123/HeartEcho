import fs from "node:fs";

// 某些 Windows EFS/重定向目录在同目录 rename 时也返回 EXDEV。
// 优先原子重命名；降级时留下上次完整文件，崩溃后 JSON 可恢复读取。
export function commitStagedFile(staged, destination) {
  try { fs.renameSync(staged, destination); }
  catch (error) {
    if (error.code !== "EXDEV") throw error;
    const previous = destination + ".previous";
    const existed = fs.existsSync(destination);
    if (existed) fs.copyFileSync(destination, previous);
    try {
      fs.copyFileSync(staged, destination);
      const fd = fs.openSync(destination, "r+");
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch (copyError) {
      if (existed) fs.copyFileSync(previous, destination);
      else fs.rmSync(destination, { force: true });
      throw copyError;
    }
    fs.unlinkSync(staged);
  }
}

export function readJsonFile(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); }
  catch {
    try { return JSON.parse(fs.readFileSync(file + ".previous", "utf8").replace(/^\uFEFF/, "")); }
    catch { return fallback; }
  }
}
