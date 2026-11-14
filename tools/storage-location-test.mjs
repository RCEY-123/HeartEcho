import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

for (const edition of ["generic", "tb"]) test(`${edition}: fresh installed data/logs/settings stay on the installation drive`, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "heartecho-location-"));
  try {
    const root = path.join(tmp, "install"), local = path.join(tmp, "system-drive");
    fs.mkdirSync(root); fs.mkdirSync(local);
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HEARTECHO_")));
    Object.assign(env, { LOCALAPPDATA: local, HEARTECHO_INSTALLED: "1", HEARTECHO_INSTALL_ROOT: root, HEARTECHO_APP_DIR: root });
    const source = `${edition === 'tb' ? 'process.argv.push("--tb");' : ''} await import(${JSON.stringify(pathToFileURL(path.resolve('lib/boot-env.mjs')).href)}); const {paths}=await import(${JSON.stringify(pathToFileURL(path.resolve('lib/paths.mjs')).href)}); console.log(JSON.stringify(paths));`;
    const args = ["--input-type=module", "-e", source, "--", ...(edition === "tb" ? ["--tb"] : [])];
    const child = spawnSync(process.execPath, args, { env, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    const locations = JSON.parse(child.stdout);
    assert.equal(locations.data, path.join(root, "data"));
    assert.equal(locations.logs, path.join(root, "data", "logs"));
    assert.equal(path.dirname(locations.settings), root);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("explicit data/log paths survive and migrated absolute media paths use the new copy", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "heartecho-relocated-"));
  try {
    const root = path.join(tmp, "install"), data = path.join(tmp, "chosen-data"), logs = path.join(tmp, "chosen-logs"), old = path.join(tmp, "old-data");
    fs.mkdirSync(root); fs.mkdirSync(path.join(data, "media"), { recursive: true }); fs.mkdirSync(path.join(data, "state"));
    const settings = path.join(root, "心语设置.json");
    fs.writeFileSync(settings, JSON.stringify({ dataDir: data, logDir: logs }));
    fs.writeFileSync(path.join(data, "media", "image.png"), "fixture");
    fs.writeFileSync(path.join(data, "state", "storage-migration.json"), JSON.stringify({ source: old, destination: data, verified: true }));
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HEARTECHO_")));
    Object.assign(env, { HEARTECHO_INSTALLED: "1", HEARTECHO_INSTALL_ROOT: root, HEARTECHO_APP_DIR: root });
    const source = `const {paths,resolveDataFile,ensureDirs}=await import(${JSON.stringify(pathToFileURL(path.resolve('lib/paths.mjs')).href)}); ensureDirs(); console.log(JSON.stringify({paths,image:resolveDataFile(${JSON.stringify(path.join(old,'media','image.png'))}),outside:resolveDataFile(${JSON.stringify(path.join(tmp,'outside.png'))})}));`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], { env, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr); const got = JSON.parse(child.stdout);
    assert.equal(got.paths.data, data); assert.equal(got.paths.logs, logs);
    assert.equal(got.image, path.join(data, "media", "image.png"));
    assert.equal(got.outside, path.join(tmp, "outside.png"));
    assert.equal(fs.existsSync(old), false, "搬迁后不能依赖旧副本存在");
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
