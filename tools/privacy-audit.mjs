// 只报告相对文件名和问题类型，绝不输出匹配值或私密来源内容。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function auditPayload(directory) {
  const repo = fileURLToPath(new URL("..", import.meta.url));
  const values = new Set();
  const add = (value) => { if (typeof value === "string" && value.length >= 8 && !/^(指挥官|localhost|127\.0\.0\.1)$/.test(value)) values.add(value); };
  const inspect = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (/api.?key|access.?token|password|secret|selfId|masterId|masterName/i.test(key)) add(String(item ?? ""));
      else if (item && typeof item === "object") inspect(item);
    }
  };
  const local = process.env.LOCALAPPDATA || "";
  const sources = [path.join(repo, "data"), path.join(repo, "dist", "data"), path.join(local, "心语"), path.join(local, "心语TB", "data")];
  for (const settingsFile of [path.join(repo, "心语设置.json"), "F:\\TB\\心语设置.json", "F:\\心语\\心语设置.json", path.join(local, "心语TB", "心语TB设置.json")]) {
    try {
      const data = JSON.parse(fs.readFileSync(settingsFile, "utf8").replace(/^\uFEFF/, ""));
      if (data.dataDir) sources.push(path.resolve(path.dirname(settingsFile), data.dataDir));
      if (data.snowlumaDir) {
        const configDir = path.resolve(path.dirname(settingsFile), data.snowlumaDir, "config");
        try {
          for (const name of fs.readdirSync(configDir).filter(name => name.endsWith(".json"))) {
            try { inspect(JSON.parse(fs.readFileSync(path.join(configDir, name), "utf8").replace(/^\uFEFF/, ""))); } catch { /* 非 JSON 不采集 */ }
          }
        } catch { /* 协议端未安装 */ }
      }
    } catch { /* 未配置 */ }
  }
  for (const source of sources) {
    try { inspect(JSON.parse(fs.readFileSync(path.join(source, "config.json"), "utf8").replace(/^\uFEFF/, ""))); } catch { /* 无旧数据 */ }
  }
  for (const [key, value] of Object.entries(process.env)) if (/API_?KEY|TRIAL_KEY|ACCESS_TOKEN/.test(key)) add(value);
  for (const home of [process.env.USERPROFILE, process.env.HOME].filter(Boolean)) {
    try {
      const env = fs.readFileSync(path.join(home, ".dsh", ".env"), "utf8");
      for (const line of env.split(/\r?\n/)) {
        const match = line.match(/^\s*[\w]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*["']?([^\r\n]*?)["']?\s*$/i);
        if (match) add(match[1]);
      }
    } catch { /* 未安装其他软件 */ }
  }
  const findings = [];
  let files = 0;
  const needles = [...values].flatMap((value) => [Buffer.from(value), Buffer.from(value, "utf16le")]);
  function walk(dir, relative = "") {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = relative ? relative + "/" + entry.name : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) { findings.push({ file: name, kind: "link" }); continue; }
      if (entry.isDirectory()) {
        if (/^(data|logs|protocol|backups|\.git|hindsight-runtime)$/.test(entry.name)) findings.push({ file: name, kind: "private-directory" });
        walk(full, name);
      } else {
        files++;
        if (/^(\.env(?:\..*)?|config\.json|panel-token|心语.*设置\.json|.*\.db(?:-wal|-shm)?)$/.test(entry.name)) findings.push({ file: name, kind: "private-file" });
        const bytes = fs.readFileSync(full);
        if (needles.some((needle) => bytes.includes(needle))) findings.push({ file: name, kind: "local-private-value" });
        const text = bytes.toString("utf8");
        if (/\bsk-[A-Za-z0-9_-]{24,}\b|-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----/.test(text)) findings.push({ file: name, kind: "credential-pattern" });
        if (/\b[A-Z]:[\\/]+Users[\\/]+(?!Public|Default)[^\\/\s"']+[\\/]/i.test(text)) findings.push({ file: name, kind: "personal-home-path" });
      }
    }
  }
  walk(directory);
  if (findings.length) throw new Error("隐私审查未通过（内容已隐藏）：" + JSON.stringify(findings));
  return { files, privateMatches: 0, credentialPatterns: 0, privateFiles: 0, personalHomePaths: 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(auditPayload(path.resolve(process.argv[2])), null, 2));
}
