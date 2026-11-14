import { commitStagedFile } from "./file-commit.mjs";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { APP_VERSION } from "./version.mjs";
import { paths } from "./paths.mjs";
import { releaseNotes } from "./release-notes.mjs";

export const UPDATE_REPOSITORY = "RCEY-123/HeartEcho";
const MAX_INSTALLER = 250 * 1024 * 1024;
const utcFreeDay = (date) =>
  [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");

function versionParts(value) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    String(value),
  );
  if (!match) return null;
  const numbers = match.slice(1, 4).map(Number),
    pre = match[4]?.split(".") || [];
  if (numbers.some((part) => !Number.isSafeInteger(part)) || pre.some((part) => !part || /^0\d+$/.test(part)))
    return null;
  return { numbers, pre };
}
export function compareVersions(a, b) {
  const left = versionParts(a),
    right = versionParts(b);
  if (!left || !right) throw new Error("版本号格式无效");
  for (let i = 0; i < 3; i++)
    if (left.numbers[i] !== right.numbers[i]) return Math.sign(left.numbers[i] - right.numbers[i]);
  if (!left.pre.length || !right.pre.length) return left.pre.length ? -1 : right.pre.length ? 1 : 0;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i],
      y = right.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x),
      yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) === BigInt(y) ? 0 : BigInt(x) > BigInt(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

function assetUrl(value, tag, name) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    decodeURIComponent(url.pathname) !== `/${UPDATE_REPOSITORY}/releases/download/${tag}/${name}`
  )
    throw new Error("更新包地址不属于官方仓库");
  return url.href;
}

export function selectRelease(releases, current, edition) {
  if (!Array.isArray(releases)) throw new Error("GitHub 返回了无效的版本信息");
  const preview = versionParts(current)?.pre.length > 0;
  return (
    releases
      .filter(
        (item) =>
          !item.draft &&
          versionParts(item.tag_name) &&
          (preview || (!item.prerelease && !versionParts(item.tag_name).pre.length)) &&
          compareVersions(item.tag_name, current) > 0,
      )
      .sort((a, b) => compareVersions(b.tag_name, a.tag_name))
      .map((item) => {
        const version = item.tag_name.replace(/^v/, "");
        // GitHub releases use ASCII asset names; retain compatibility with older local-name releases.
        const names = [
          (edition === "tb" ? "HeartEcho-TB-" : "HeartEcho-") + version + "-Setup.exe",
          (edition === "tb" ? "领航员终端-" : "心语-") + version + "-安装.exe",
        ];
        const assets = Array.isArray(item.assets) ? item.assets : [];
        const name = names.find((candidate) => assets.some((asset) => asset.name === candidate) && assets.some((asset) => asset.name === candidate + ".sha256"));
        const installer = assets.find((asset) => asset.name === name);
        const checksum = assets.find((asset) => asset.name === name + ".sha256");
        if (
          !installer ||
          !checksum ||
          !Number.isSafeInteger(installer.size) ||
          installer.size <= 0 ||
          installer.size > MAX_INSTALLER
        )
          return null;
        return {
          version,
          name,
          notes: String(item.body || "此版本未提供更新说明。").slice(0, 24000),
          url: `https://github.com/${UPDATE_REPOSITORY}/releases/tag/${encodeURIComponent(item.tag_name)}`,
          downloadUrl: assetUrl(installer.browser_download_url, item.tag_name, name),
          checksumUrl: assetUrl(checksum.browser_download_url, item.tag_name, name + ".sha256"),
          bytes: installer.size,
        };
      })
      .find(Boolean) || null
  );
}

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function githubFailure(error) {
  const codes = new Set();
  const queue = [error];
  const seen = new Set();
  while (queue.length && seen.size < 20) {
    const entry = queue.shift();
    if (!entry || typeof entry !== "object" || seen.has(entry)) continue;
    seen.add(entry);
    codes.add(entry.code);
    codes.add(entry.name);
    queue.push(entry.cause);
    if (Array.isArray(entry.errors)) queue.push(...entry.errors);
  }
  if (codes.has("ENOTFOUND") || codes.has("EAI_AGAIN"))
    return { failureKind: "dns", detail: "无法通过 DNS 解析 GitHub 地址。请检查网络或 DNS 设置；这不代表已确认 DNS 污染。" };
  if (["TimeoutError", "AbortError", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].some((code) => codes.has(code)))
    return { failureKind: "timeout", detail: "连接 GitHub 超时。请检查网络连接、代理设置后重新检查。" };
  if ([...codes].some((code) => typeof code === "string" && /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)))
    return { failureKind: "tls", detail: "GitHub 安全连接或证书校验失败。请检查系统时间、代理与网络设置。" };
  if (codes.has("GITHUB_RATE_LIMIT"))
    return { failureKind: "rate-limit", detail: "GitHub 暂时限制访问，请稍后再试。" };
  if (codes.has("GITHUB_HTTP"))
    return { failureKind: "http", detail: "GitHub 返回 HTTP " + error.status + "，暂时无法读取版本信息。" };
  if (codes.has("SyntaxError") || codes.has("GITHUB_RESPONSE"))
    return { failureKind: "response", detail: "未能取得有效的官方版本信息，请检查网络或代理后重试。" };
  return { failureKind: "network", detail: "无法连接 GitHub。请检查网络、防火墙或代理设置后重新检查；不能仅据此判断是否存在 DNS 污染。" };
}

export class UpdateManager {
  constructor({
    dataDir = paths.data,
    currentVersion = APP_VERSION,
    edition = process.env.HEARTECHO_EDITION === "tb" ? "tb" : "generic",
    installed = paths.installed,
    installRoot = paths.installRoot,
    fetcher = (...args) => fetch(...args),
    launcher = spawn,
    quit = () => {},
    now = () => new Date(),
    platform = process.platform,
  } = {}) {
    Object.assign(this, {
      dataDir,
      currentVersion,
      edition,
      installed,
      installRoot,
      fetcher,
      launcher,
      quit,
      now,
      platform,
    });
    this.file = path.join(dataDir, "state", "updates.json");
    this.saved = readJson(this.file);
    this.state = { state: "idle", currentVersion, edition, repository: UPDATE_REPOSITORY };
    const receipt = readJson(path.join(dataDir, "state", "update-install.json"));
    const from = receipt.version === currentVersion ? receipt.fromVersion : this.saved.lastRunVersion;
    const pendingCurrentNotice = this.saved.notice?.version === currentVersion;
    if (this.saved.acknowledgedVersion !== currentVersion && ((from && from !== currentVersion) || pendingCurrentNotice))
      this.saved.notice = { ...releaseNotes, version: currentVersion, fromVersion: pendingCurrentNotice ? this.saved.notice.fromVersion : from };
    else delete this.saved.notice;
    this.saved.lastRunVersion = currentVersion;
    this.persist();
  }
  persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + ".tmp", JSON.stringify(this.saved, null, 2));
    commitStagedFile(this.file + ".tmp", this.file);
  }
  status() {
    return {
      ok: true,
      ...this.state,
      installed: this.installed,
      notice: this.saved.notice || null,
      currentNotes: { ...releaseNotes, version: this.currentVersion },
      githubPrompt: this.state.state === "unavailable" && this.saved.githubSuppressedDay !== utcFreeDay(this.now()),
    };
  }
  suppressToday() {
    this.saved.githubSuppressedDay = utcFreeDay(this.now());
    this.persist();
    return this.status();
  }
  acknowledge(version) {
    if (version !== this.currentVersion) throw new Error("版本已变化，请刷新后重试");
    this.saved.acknowledgedVersion = version;
    delete this.saved.notice;
    this.persist();
    return { ok: true };
  }
  async check() {
    if (this.checking) return this.checking;
    if (["downloading", "ready", "installing"].includes(this.state.state)) return this.status();
    this.state = { ...this.state, state: "checking", message: "正在访问 GitHub 检查更新…" };
    this.checking = (async () => {
      try {
        const response = await this.fetcher(`https://api.github.com/repos/${UPDATE_REPOSITORY}/releases?per_page=20`, {
          headers: { Accept: "application/vnd.github+json", "User-Agent": "HeartEcho/" + this.currentVersion },
          signal: AbortSignal.timeout(8000),
          redirect: "error",
          cache: "no-store",
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw Object.assign(new Error("GitHub request failed"), {
            code: response.status === 403 || response.status === 429 ? "GITHUB_RATE_LIMIT" : "GITHUB_HTTP",
            status: response.status,
          });
        }
        const bytes = await this.readBounded(response, 2 * 1024 * 1024);
        const releases = JSON.parse(bytes.toString("utf8"));
        if (!Array.isArray(releases) || releases.some((item) => !item || typeof item !== "object" || typeof item.tag_name !== "string"))
          throw Object.assign(new Error("Invalid GitHub releases response"), { code: "GITHUB_RESPONSE" });
        const release = selectRelease(releases, this.currentVersion, this.edition);
        this.state = {
          ...this.state,
          state: release ? "available" : "current",
          release,
          checkedAt: this.now().getTime(),
          message: release ? "发现新版本" : "当前没有适用于此版本的更新",
        };
        delete this.state.failureKind;
        delete this.state.detail;
      } catch (error) {
        this.state = {
          ...this.state,
          state: "unavailable",
          release: null,
          checkedAt: this.now().getTime(),
          message: "无法读取 GitHub 仓库的版本信息，本次未能确认是否有更新。聊天和记忆功能仍可使用。",
          ...githubFailure(error),
        };
      }
      return this.status();
    })().finally(() => { this.checking = null; });
    return this.checking;
  }
  async readBounded(response, maximum) {
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body || []) {
      size += chunk.length;
      if (size > maximum) throw new Error("更新响应超过大小限制");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  async downloadResponse(url, signal) {
    for (let i = 0; i < 6; i++) {
      const parsed = new URL(url);
      if (
        parsed.protocol !== "https:" ||
        parsed.username ||
        parsed.password ||
        parsed.port ||
        ![
          "github.com",
          "release-assets.githubusercontent.com",
          "objects.githubusercontent.com",
          "github-releases.githubusercontent.com",
        ].includes(parsed.hostname)
      )
        throw new Error("下载被重定向到不受信任的地址");
      const response = await this.fetcher(parsed.href, {
        signal,
        redirect: "manual",
        headers: { "User-Agent": "HeartEcho/" + this.currentVersion },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const next = response.headers.get("location");
        await response.body?.cancel();
        if (!next) throw new Error("下载重定向无效");
        url = new URL(next, url).href;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("更新下载失败（HTTP " + response.status + "）");
      }
      return response;
    }
    throw new Error("下载重定向次数过多");
  }
  beginDownload({ version, agreed }) {
    if (!agreed || version !== this.state.release?.version) throw new Error("请先确认当前版本的下载");
    if (this.state.state === "downloading" || this.state.state === "ready") return this.status();
    if (this.state.state !== "available" && this.state.state !== "error") throw new Error("请先检查可用更新");
    this.state.state = "downloading";
    this.state.downloadedBytes = 0;
    this.downloading = this.download().catch((error) => {
      this.state.state = "error";
      this.state.message = error.message;
    });
    return this.status();
  }
  async download() {
    const release = { ...this.state.release };
    const signal = AbortSignal.timeout(5 * 60 * 1000);
    const checksum = await this.readBounded(await this.downloadResponse(release.checksumUrl, signal), 4096);
    const match = /^([a-f0-9]{64})(?:\s+\*?([^\r\n]+))?\s*$/i.exec(checksum.toString("utf8").trim());
    if (!match || (match[2] && match[2] !== release.name)) throw new Error("更新校验文件无效");
    const directory = path.join(this.dataDir, "updates", randomUUID());
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, release.name),
      partial = file + ".part";
    let fd;
    try {
      const response = await this.downloadResponse(release.downloadUrl, signal);
      fd = fs.openSync(partial, "wx");
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of response.body || []) {
        size += chunk.length;
        if (size > release.bytes || size > MAX_INSTALLER) throw new Error("更新包大小异常");
        hash.update(chunk);
        fs.writeSync(fd, chunk);
        this.state.downloadedBytes = size;
      }
      fs.closeSync(fd);
      fd = undefined;
      if (size !== release.bytes || hash.digest("hex") !== match[1].toLowerCase())
        throw new Error("更新包校验失败，请重新下载");
      commitStagedFile(partial, file);
      this.downloaded = { file, hash: match[1].toLowerCase(), version: release.version };
      this.state.state = "ready";
      this.state.message = "更新已下载并通过校验";
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      fs.rmSync(partial, { force: true });
    }
  }
  async install({ version, agreed }) {
    if (!agreed || this.state.state !== "ready" || !this.downloaded || version !== this.downloaded.version)
      throw new Error("请先下载并确认安装此版本");
    if (this.platform !== "win32") throw new Error("自动安装仅支持 Windows，请从项目发布页安装适用版本");
    const { file, hash } = this.downloaded;
    if (createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== hash)
      throw new Error("安装包已变化，请重新下载");
    const args = ["--wait-pid=" + process.pid];
    if (this.installed) {
      const marker = fs.readFileSync(path.join(this.installRoot, "INSTALL-EDITION.txt"), "utf8").trim();
      if (marker !== this.edition) throw new Error("安装版本不匹配，已停止更新");
      args.push(
        "--silent",
        "--accept-license",
        "--update",
        "--register",
        "--notify-errors",
        "--launch",
        "--dir=" + this.installRoot,
      );
    }
    this.state.state = "installing";
    try {
      const child = this.launcher(file, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        cwd: path.dirname(file),
      });
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
    } catch (error) {
      this.state.state = "ready";
      throw error;
    }
    // 先回复面板，再正常关闭当前实例；安装器会等待该进程退出。
    const timer = setTimeout(() => this.quit(), 500);
    timer.unref?.();
    return { ok: true, state: "installing" };
  }
}
