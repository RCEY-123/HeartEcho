# dev.18 默认分支源码同步

更新日期：2026-11-14（Asia/Shanghai）

## 需求与基线

用户反馈 GitHub 默认分支源码过旧，要求核对并上传最新源码。

- 同步前 `main`：`890e00fe667725c70708a2a1be0a228e99fd266d`，`package.json` 为 `1.3.0-dev.0`。
- 已发布版本：[v1.3.0-dev.18](https://github.com/RCEY-123/HeartEcho/releases/tag/v1.3.0-dev.18)。
- 原因：上次发布上传了安装包、源码附件和应用源码快照标签，但未同步默认分支。
- 本次从原 `main` 继续提交，补齐 dev.18 完整开发源码、测试、构建工具、使用文档和开发技能，保留已有角色卡、其他仓库文件和提交历史。
- 发布标签仍指向原应用源码快照；本次不改写标签或已发布附件。

## 状态与验收

| 任务 | 状态 | 验收条件 |
| --- | --- | --- |
| 基线核对 | 完成 | 默认分支 dev.0 与 Release dev.18 差异已确认 |
| 整理源码 | 完成 | 使用已发布并通过隐私审查的完整开发源码附件作为同步来源 |
| 一致性与隐私检查 | 完成 | 两版最终负载各 164 个文件一致；338 个待提交文件通过隐私检查 |
| 回归验证 | 完成 | 266 项源码回归、5 项实际浏览器流程、98 项离线自检通过，无跳过 |
| 上传与远端复查 | 完成 | 源码提交 `6647ddf5b1f5ca405bc68d3439a076c43237f025` 已正常推送 main；GitHub API 复查版本为 dev.18、提交和完整文件树与本地一致 |

## 源码使用

源码运行可使用 Node.js 22.5+；开发检查建议 Node.js 24，Windows 安装包构建需要 Node.js 24 或更新版本。

```powershell
npm ci
npm run selftest
node index.mjs --tray
```

完整回归选择与执行：

```powershell
python skills/heartecho-development/scripts/regression_guard.py --root . --release
python skills/heartecho-development/scripts/regression_guard.py --root . --release --run --report build/regression-report.json
```

`npm run lint` 和 `npm run format:check` 保留现有检查规则；存量问题见 [开发说明](../CONTRIBUTING.md)。本次仅同步已发布源码，不进行全仓格式化。

此前安装包验收和未验证范围见 [dev.18 验收记录](dev18-validation.md)。

本次首轮沙箱回归有 3 项因注册表/本机用户目录访问受限而失败；在沙箱外重新执行相同计划，266 项全部通过。实际提交树另行导出检查，与已发布完整开发源码一致；扩展注册表按仓库惯例不提交，由 `tools/gen-extensions.mjs` 从扩展源码重建。重建后与两版负载一致。文本比较按 `.gitattributes` 统一 CRLF/LF，不改变程序逻辑。

`git diff --check` 检出已发布测试文件 `tools/conversation-flow-test.mjs` 的一处文件尾空行，保留已验收源码。两版应用文件、锁文件版本和安装负载源码清单检查均通过。本次没有新建或替换安装包；真实 QQ、付费模型和干净 Windows 图形安装未重测。
