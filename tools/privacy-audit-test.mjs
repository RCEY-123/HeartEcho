import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { auditPayload } from "./privacy-audit.mjs";

test("隐私构建门槛拒绝本机凭据、数据目录和个人路径，错误不打印秘密", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "heartecho-audit-"));
  const prior = process.env.HEARTECHO_TEST_API_KEY;
  const secret = "SYNTHETIC_SECRET_FOR_AUDIT_" + Date.now();
  process.env.HEARTECHO_TEST_API_KEY = secret;
  try {
    const file = path.join(temp, "code.txt");
    fs.writeFileSync(file, secret);
    assert.throws(() => auditPayload(temp), (error) => error.message.includes("local-private-value") && !error.message.includes(secret));
    fs.writeFileSync(file, ["C:", "Users", "synthetic-person", "private"].join("\\"));
    assert.throws(() => auditPayload(temp), /personal-home-path/);
    fs.unlinkSync(file);
    fs.mkdirSync(path.join(temp, "data"));
    assert.throws(() => auditPayload(temp), /private-directory/);
    fs.rmdirSync(path.join(temp, "data"));
    fs.writeFileSync(file, "public application source");
    assert.equal(auditPayload(temp).privateMatches, 0);
  } finally {
    if (prior === undefined) delete process.env.HEARTECHO_TEST_API_KEY;
    else process.env.HEARTECHO_TEST_API_KEY = prior;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
