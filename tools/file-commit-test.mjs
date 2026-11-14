import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { commitStagedFile, readJsonFile } from "../lib/file-commit.mjs";

test("EXDEV文件系统仍可保存，部分写入失败保留原文件，损坏后可读上次完整内容", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "heartecho-file-commit-"));
  const staged = path.join(temp, "config.json.tmp"), file = path.join(temp, "config.json");
  const rename = fs.renameSync, copy = fs.copyFileSync;
  try {
    fs.writeFileSync(file, '{"state":"old"}');
    fs.writeFileSync(staged, '{"state":"new"}');
    fs.renameSync = () => { throw Object.assign(new Error("synthetic EFS"), { code: "EXDEV" }); };
    commitStagedFile(staged, file);
    assert.equal(readJsonFile(file, {}).state, "new");
    assert.equal(fs.existsSync(staged), false);
    fs.writeFileSync(staged, '{"state":"third"}');
    fs.copyFileSync = (from, to, ...rest) => {
      if (from === staged) { fs.writeFileSync(to, "{"); throw Object.assign(new Error("synthetic interrupted write"), { code: "EIO" }); }
      return copy(from, to, ...rest);
    };
    assert.throws(() => commitStagedFile(staged, file), /synthetic interrupted write/);
    assert.equal(readJsonFile(file, {}).state, "new");
    fs.writeFileSync(file, "{");
    assert.equal(readJsonFile(file, {}).state, "new");
  } finally {
    fs.renameSync = rename; fs.copyFileSync = copy;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
