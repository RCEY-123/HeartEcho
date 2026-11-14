# dev.18 更新公告与新功能引导

## 改动与影响

- `lib/release-notes.mjs` 只保留本版三条变化：角色卡管理、回复标记修复、公告与功能引导。历史说明从 GitHub 发布记录查看。
- `lib/updates.mjs` 用当前随包说明重建本版待确认公告，丢弃过期或已确认的残留公告；跨版本升级只显示当前版。`currentNotes` 为手动重看提供本版说明。
- `lib/ui-update-guide.mjs` 增加“看看新功能”入口，进入角色工作室，依次用箭头和高亮定位导入、导出、删除按钮。支持上一步、跳过、完成、Escape，以及窄窗口重新定位。
- 开始引导或关闭公告前，先向服务端保存本版已读；失败时保留公告并允许重试。已读后重新打开窗口不会自动重复。运行环境“本版更新与引导”可以再次查看。
- 引导期间暂缓其他自动更新弹窗；下载与安装仍保持原来的分别确认流程。
- 主 agent 已将新增模块纳入安装负载清单。通用版和 TB 使用相同引导代码及独立更新状态。

## 已完成验证

在 `E:\HeartEcho install\dev18-workspace` 执行：

| 命令 | 实际结果 |
| --- | --- |
| `node --test tools/updates-test.mjs` | 15/15 通过，无跳过；覆盖跨版本升级、旧公告缓存、本版待确认公告重建、确认后重启和手动重看数据 |
| `node --test tools/tooling-test.mjs` | 6/6 通过，无跳过 |
| `node --check lib/ui-update-guide.mjs`、`node --check lib/ui-app.mjs`、`node --check tools/update-startup-browser-test.mjs` | 通过 |
| 对导出的 `APP_JS` 执行 `new Function(APP_JS)` | 浏览器脚本语法通过 |
| ESLint 检查新增引导模块、公告、更新器及两份相关测试 | 无诊断输出 |

基线 `APP_JS` 已使用独立 `CONTINUITY_UI` 拼接；本次采用同类模块注入方式。主 agent 已确认整文件 ESLint 的静态模板预处理报错为既有问题，本次未扩大修改工具。

## 浏览器验收状态

已扩展 `tools/update-startup-browser-test.mjs`，通用版和 TB 两项源码浏览器测试均通过，无跳过，实际验证：

- 升级弹窗只显示当前版三条内容，无历史版本段落。
- 点击开始后进入真实角色工作室，三步高亮包围正确按钮，箭头存在，说明卡位于窗口内。
- 上一步、下一步、完成；窄窗口布局；已读状态实际写入 `state/updates.json`。
- 重开窗口不重复；从运行环境重新查看；跳过后重开不重复。
- 原有断网提示、今日抑制、手动检查、版型选择、下载同意及安装前等待流程。

主 agent 统一执行：`node --test --test-reporter=tap tools/local-chat-browser-test.mjs tools/character-cards-browser-test.mjs tools/update-startup-browser-test.mjs`。日志位于 `build/dev18-browser-source.log`，其中本组 `browser updates: generic` 与 `browser updates: tb` 分别为 `ok 4`、`ok 5`，耗时约 7.3 秒、6.3 秒。同次日志的总计为 4 通过、1 失败；失败项是另一个角色卡 TB 测试的“隔离模型回复”等待超时，不能把该整组运行记为全部通过。其处理结果由主 agent 另行记录。

截图已写入 `build/dev18-update-qa`：每版均有 `*-updated-notice.png`、`*-feature-guide.png`、`*-feature-guide-narrow.png` 和 `*-github-unavailable.png`，共八张。主 agent 已目视核验公告、桌面引导与 480 像素宽窗口引导，确认布局、箭头与高亮清楚。

本次复核源码仍只包含三条当前版本公告；过期公告清除、已读持久化及手动重看接口与通过测试时一致。未重新运行浏览器。真实 GitHub 下载、真实安装及最终安装负载不属于本组源码浏览器证据，须以主 agent 的对应验收报告为准。
