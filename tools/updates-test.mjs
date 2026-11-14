import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { compareVersions, selectRelease, UpdateManager } from "../lib/updates.mjs";
import { releaseNotes } from "../lib/release-notes.mjs";

const bytes = Buffer.from("synthetic installer - never execute");
const hash = createHash("sha256").update(bytes).digest("hex");
function release(version = "1.3.0-dev.3", edition = "tb") {
  const name = (edition === "tb" ? "领航员终端-" : "心语-") + version + "-安装.exe";
  const url = "https://github.com/RCEY-123/HeartEcho/releases/download/v" + version + "/";
  return {
    tag_name: "v" + version,
    prerelease: version.includes("-"),
    body: "更新内容 <script>不会执行</script>",
    assets: [
      { name, size: bytes.length, browser_download_url: url + encodeURIComponent(name) },
      { name: name + ".sha256", size: 100, browser_download_url: url + encodeURIComponent(name + ".sha256") },
    ],
  };
}
function publishedRelease(version = "1.3.0-dev.9", edition = "generic") {
  const item = release(version, edition);
  const name = (edition === "tb" ? "HeartEcho-TB-" : "HeartEcho-") + version + "-Setup.exe";
  for (const [i, asset] of item.assets.entries()) {
    asset.name = name + (i ? ".sha256" : "");
    asset.browser_download_url = `https://github.com/RCEY-123/HeartEcho/releases/download/v${version}/${asset.name}`;
  }
  return item;
}
function fixture(t, options = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "heartecho-updates-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const requests = [];
  const info = release();
  const fetcher = async (url) => {
    requests.push(url);
    if (url.startsWith("https://api.github.com/")) return new Response(JSON.stringify([info]), { status: 200 });
    if (url.endsWith(".sha256")) return new Response(hash + "  " + info.assets[0].name + "\n");
    return new Response(bytes);
  };
  const manager = new UpdateManager({
    dataDir: tmp,
    currentVersion: "1.3.0-dev.2",
    edition: "tb",
    fetcher,
    platform: "win32",
    ...options,
  });
  return { manager, tmp, requests };
}

test("version ordering compares numbers and prereleases rather than strings", () => {
  assert.equal(compareVersions("v1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("1.3.0-dev.10", "1.3.0-dev.2"), 1);
  assert.equal(compareVersions("1.3.0-dev.17.1", "1.3.0-dev.17"), 1);
  assert.equal(compareVersions("1.3.0", "1.3.0-dev.999"), 1);
  assert.equal(compareVersions("1.3.0+build", "1.3.0"), 0);
  assert.throws(() => compareVersions("main", "1.0.0"));
  assert.throws(() => compareVersions("1.3.0-dev..2", "1.3.0"));
  assert.throws(() => compareVersions("1.3.0-dev.02", "1.3.0"));
  assert.equal(compareVersions("1.3.0-dev.99999999999999999999", "1.3.0-dev.99999999999999999998"), 1);
});
test("release selection keeps editions and stable/preview channels separate", () => {
  assert.equal(selectRelease([release()], "1.3.0-dev.2", "tb").version, "1.3.0-dev.3");
  assert.equal(selectRelease([release()], "1.2.0", "tb"), null);
  assert.equal(selectRelease([release()], "1.3.0-dev.2", "generic"), null);
  assert.equal(selectRelease([{ ...release(), draft: true }], "1.3.0-dev.2", "tb"), null);
  const forged = release();
  forged.assets[0].browser_download_url = "https://example.org/setup.exe";
  assert.throws(() => selectRelease([forged], "1.3.0-dev.2", "tb"), /官方仓库/);
});

test("actual GitHub ASCII release assets are detected and downloaded for the correct edition", async (t) => {
  for (const edition of ["generic", "tb"]) {
    const info = publishedRelease("1.3.0-dev.9", edition);
    const other = publishedRelease("1.3.0-dev.9", edition === "tb" ? "generic" : "tb");
    const { manager, requests } = fixture(t, {
      edition,
      currentVersion: "1.3.0-dev.8",
      fetcher: async (url) => {
        requests.push(url);
        if (url.includes("api.github.com")) return new Response(JSON.stringify([{ ...info, assets: [...other.assets, ...info.assets] }]));
        return url.endsWith(".sha256") ? new Response(hash + "  " + info.assets[0].name) : new Response(bytes);
      },
    });
    const status = await manager.check();
    assert.equal(status.state, "available", "a reachable repository must not hide its actual published installer");
    assert.equal(status.release.name, info.assets[0].name);
    assert.equal(requests.length, 1, "checking never downloads without consent");
    manager.beginDownload({ version: info.tag_name.slice(1), agreed: true });
    await manager.downloading;
    assert.equal(manager.status().state, "ready");
    assert.equal(fs.readFileSync(manager.downloaded.file).toString(), bytes.toString());
  }
});

test("unreachable GitHub reports DNS, timeout, TLS and rate limits without claiming DNS poisoning", async (t) => {
  const cases = [
    [() => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("sensitive-network-value"), { code: "ENOTFOUND" }) }); }, "dns", /DNS/],
    [() => { throw new DOMException("timed out", "TimeoutError"); }, "timeout", /超时/],
    [() => { throw new TypeError("fetch failed", { cause: { code: "CERT_HAS_EXPIRED" } }); }, "tls", /证书/],
    [() => new Response("limited", { status: 403 }), "rate-limit", /限制/],
    [() => new Response("<html>intercepted</html>"), "response", /版本信息/],
  ];
  for (const [fetcher, kind, detail] of cases) {
    const { manager } = fixture(t, { fetcher });
    const status = await manager.check();
    assert.equal(status.state, "unavailable");
    assert.equal(status.githubPrompt, true);
    assert.equal(status.failureKind, kind);
    assert.match(status.detail, detail);
    assert.doesNotMatch(status.detail, /sensitive-network-value|已.*DNS污染/);
    assert.ok(status.checkedAt);
  }
});

test("every new check contacts GitHub without cache, including after a synchronous DNS failure and suppression", async (t) => {
  let fail = true;
  const calls = [];
  const { manager, tmp } = fixture(t, { fetcher: (url, options) => {
    calls.push({ url, options });
    if (fail) throw new TypeError("fetch failed", { cause: { code: "EAI_AGAIN" } });
    return Promise.resolve(new Response("[]"));
  } });
  await manager.check();
  manager.suppressToday();
  fail = false;
  assert.equal((await manager.check()).state, "current", "retry must actually issue a new request");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.cache, "no-store");
  assert.equal(manager.status().failureKind, undefined);
  assert.equal(manager.status().detail, undefined);
  const restarted = new UpdateManager({ dataDir: tmp, fetcher: manager.fetcher });
  assert.equal((await restarted.check()).state, "current");
  assert.equal(calls.length, 3, "today's prompt suppression never disables checking after restart");
});
test("startup checks only metadata; no download or execution without consent", async (t) => {
  const { manager, requests } = fixture(t);
  await manager.check();
  assert.equal(manager.status().state, "available");
  assert.equal(requests.length, 1);
  assert.throws(() => manager.beginDownload({ version: "1.3.0-dev.3", agreed: false }), /确认/);
  await assert.rejects(manager.install({ version: "1.3.0-dev.3", agreed: true }), /先下载/);
  assert.equal(requests.length, 1);
});
test("GitHub failure can be suppressed for today, persists across restarts and expires tomorrow", async (t) => {
  let date = new Date(2026, 9, 31, 12);
  const fetcher = async () => {
    throw new Error("offline");
  };
  const { manager, tmp } = fixture(t, { now: () => date, fetcher });
  await manager.check();
  assert.equal(manager.status().githubPrompt, true);
  manager.suppressToday();
  assert.equal(manager.status().githubPrompt, false);
  const restarted = new UpdateManager({ dataDir: tmp, currentVersion: "1.3.0-dev.2", now: () => date, fetcher });
  await restarted.check();
  assert.equal(restarted.status().githubPrompt, false);
  date = new Date(2026, 10, 1, 0, 1);
  assert.equal(restarted.status().githubPrompt, true);
});
test("successful download checks size and SHA-256 and never executes by itself", async (t) => {
  let executed = false;
  const { manager } = fixture(t, {
    launcher: () => {
      executed = true;
    },
  });
  await manager.check();
  manager.beginDownload({ version: "1.3.0-dev.3", agreed: true });
  await manager.downloading;
  assert.equal(manager.status().state, "ready");
  assert.equal(executed, false);
  assert.deepEqual(fs.readFileSync(manager.downloaded.file), bytes);
});
test("corrupt downloads fail closed and clean up partial files", async (t) => {
  const info = release();
  const { manager, tmp } = fixture(t, {
    fetcher: async (url) =>
      url.includes("api.github.com")
        ? new Response(JSON.stringify([info]))
        : url.endsWith(".sha256")
          ? new Response("0".repeat(64) + "  " + info.assets[0].name)
          : new Response(bytes),
  });
  await manager.check();
  manager.beginDownload({ version: "1.3.0-dev.3", agreed: true });
  await manager.downloading;
  assert.equal(manager.status().state, "error");
  assert.equal(manager.downloaded, undefined);
  for (const dir of fs.readdirSync(path.join(tmp, "updates")))
    assert.deepEqual(fs.readdirSync(path.join(tmp, "updates", dir)), []);
});
test("download redirects cannot contact arbitrary hosts", async (t) => {
  let outside = false;
  const info = release();
  const { manager } = fixture(t, {
    fetcher: async (url) => {
      if (url.includes("api.github.com")) return new Response(JSON.stringify([info]));
      if (url.includes("example.org")) outside = true;
      return new Response(null, { status: 302, headers: { location: "https://example.org/installer" } });
    },
  });
  await manager.check();
  manager.beginDownload({ version: "1.3.0-dev.3", agreed: true });
  await manager.downloading;
  assert.equal(manager.status().state, "error");
  assert.equal(outside, false);
});
test("installation rechecks integrity, uses the current custom directory and waits for app exit", async (t) => {
  let launched;
  let exited;
  const quitting = new Promise((resolve) => {
    exited = resolve;
  });
  const { manager, tmp } = fixture(t, {
    installed: true,
    quit: () => exited(),
    launcher: (file, args, options) => {
      launched = { file, args, options };
      const child = new EventEmitter();
      child.unref = () => {};
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });
  const installRoot = path.join(tmp, "自定义 TB 安装目录");
  fs.mkdirSync(installRoot);
  fs.writeFileSync(path.join(installRoot, "INSTALL-EDITION.txt"), "tb");
  manager.installRoot = installRoot;
  await manager.check();
  manager.beginDownload({ version: "1.3.0-dev.3", agreed: true });
  await manager.downloading;
  fs.appendFileSync(manager.downloaded.file, "tampered");
  await assert.rejects(manager.install({ version: "1.3.0-dev.3", agreed: true }), /已变化/);
  assert.equal(launched, undefined);
  fs.writeFileSync(manager.downloaded.file, bytes);
  await manager.install({ version: "1.3.0-dev.3", agreed: true });
  assert.ok(launched.args.includes("--dir=" + installRoot));
  assert.ok(launched.args.includes("--wait-pid=" + process.pid));
  assert.ok(launched.args.includes("--update"));
  assert.equal(launched.options.shell, undefined);
  assert.equal(launched.options.windowsHide, true);
  await quitting;
});
test("overlay-install receipt displays bundled release notes until acknowledged", (t) => {
  const { tmp } = fixture(t);
  fs.writeFileSync(
    path.join(tmp, "state", "update-install.json"),
    JSON.stringify({ fromVersion: "1.3.0-dev.1", version: "1.3.0-dev.2" }),
  );
  const updated = new UpdateManager({ dataDir: tmp, currentVersion: "1.3.0-dev.2" });
  assert.equal(updated.status().notice.version, "1.3.0-dev.2");
  assert.equal(updated.status().notice.body, releaseNotes.body);
  assert.throws(() => updated.acknowledge("other"));
  updated.acknowledge("1.3.0-dev.2");
  assert.equal(new UpdateManager({ dataDir: tmp, currentVersion: "1.3.0-dev.2" }).status().notice, null);
});

test("skipping versions replaces old pending announcements with only the installed version", (t) => {
  const { tmp } = fixture(t);
  fs.writeFileSync(path.join(tmp, "state", "updates.json"), JSON.stringify({
    lastRunVersion: "1.3.0-dev.12", acknowledgedVersion: "1.3.0-dev.11",
    notice: { version: "1.3.0-dev.12", title: "旧版公告", body: "不应再显示的累计历史" },
  }));
  const updated = new UpdateManager({ dataDir: tmp, currentVersion: "1.3.0-dev.18" });
  assert.equal(updated.status().notice.version, "1.3.0-dev.18");
  assert.equal(updated.status().notice.fromVersion, "1.3.0-dev.12");
  assert.equal(updated.status().notice.body, releaseNotes.body);
  assert.equal(updated.status().notice.guide, "character-cards");
  assert.doesNotMatch(updated.status().notice.body, /累计历史|dev\.1[2-7]/);
  assert.equal(new UpdateManager({ dataDir: tmp, currentVersion: "1.3.0-dev.18" }).status().notice.body, releaseNotes.body);
  updated.acknowledge("1.3.0-dev.18");
  const restarted = new UpdateManager({ dataDir: tmp, currentVersion: "1.3.0-dev.18" });
  assert.equal(restarted.status().notice, null);
  assert.equal(restarted.status().currentNotes.body, releaseNotes.body, "acknowledged notes remain available for manual replay");
});

test("stale persisted notices cannot display an old version or survive acknowledgement", (t) => {
  const { tmp } = fixture(t);
  for (const saved of [
    { lastRunVersion: "1.3.0-dev.18", notice: { version: "1.3.0-dev.17", body: "旧公告" } },
    { lastRunVersion: "1.3.0-dev.18", acknowledgedVersion: "1.3.0-dev.18", notice: { version: "1.3.0-dev.18", body: "已读公告" } },
  ]) {
    fs.writeFileSync(path.join(tmp, "state", "updates.json"), JSON.stringify(saved));
    assert.equal(new UpdateManager({ dataDir: tmp, currentVersion: "1.3.0-dev.18" }).status().notice, null);
  }
  fs.writeFileSync(path.join(tmp, "state", "updates.json"), JSON.stringify({
    lastRunVersion: "1.3.0-dev.18", notice: { version: "1.3.0-dev.18", body: "缓存的累计历史", fromVersion: "1.3.0-dev.17.1" },
  }));
  assert.equal(new UpdateManager({ dataDir: tmp, currentVersion: "1.3.0-dev.18" }).status().notice.body, releaseNotes.body);
});

test("a malformed optional update-state file cannot prevent application startup", (t) => {
  const { tmp } = fixture(t);
  for (const value of ["null", "[]", "not json", "42"]) {
    fs.writeFileSync(path.join(tmp, "state", "updates.json"), value);
    const manager = new UpdateManager({ dataDir: tmp, currentVersion: "1.3.0-dev.2" });
    assert.equal(manager.status().state, "idle");
  }
});
