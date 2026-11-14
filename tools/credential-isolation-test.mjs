import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('新安装不从环境变量或其他软件的私密文件自动读取 API Key', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'heartecho-credentials-'));
  try {
    fs.mkdirSync(path.join(temp, '.dsh'));
    fs.writeFileSync(path.join(temp, '.dsh', '.env'), 'DEEPSEEK_API_KEY=SYNTHETIC_PRIVATE_FILE_ONLY');
    for (const external of ['', 'SYNTHETIC_EXTERNAL_ENV_ONLY']) {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e',
        "import {loadConfig} from './lib/config.mjs'; const c=loadConfig(); process.exit(Object.values(c.llm.profiles).every(p=>!p.apiKey)?0:9);"], {
        env: { ...process.env, HEARTECHO_DATA_DIR: path.join(temp, 'data'), HEARTECHO_SETTINGS: path.join(temp, 'settings.json'), USERPROFILE: temp, HOME: temp,
          HEARTECHO_API_KEY: external, DEEPSEEK_API_KEY: external, HEARTECHO_TRIAL_KEY: external },
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, '首次运行自动使用了外部凭据（不输出凭据值）');
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
