# dev.18 角色卡管理实现与验证

基线：本机 dev.17.1 源码副本；原 `E:\心语` 及真实用户数据未修改。

## 已确认的产品行为

- 角色工作室支持多选原生 JSON 导入、导出已保存角色卡、删除角色卡。格式据仓库 `角色卡/碧蓝航线` 的 22 张卡核对；不支持 ZIP。
- 同 ID（含大小写冲突）跳过并逐项反馈，不覆盖已有卡，不自动切换当前角色或编辑卡，不丢未保存表单。
- 每次最多 50 张，每张不超过 1 MB，实际 JSON 请求总量不超过 12 MB；客户端与服务端均检查，低于 API 16 MB 入口限制。
- 导出共享设定与白名单来源元数据；“关于你”、QQ 绑定、本地头像路径和其他非共享字段不进入导出。聊天、记忆、成长状态不属于角色卡。
- 删除由应用用户选择保留数据（默认）或清理归属该角色的数据；有明确确认与取消，至少保留一张角色卡。保留后可重新导入同 ID 恢复原记录。
- 清数据涵盖有明确归属的消息、记忆/日记/反思、成长、身体状态、授权及本地会话日程等。其他角色、独立备份和无法确认归属的旧记录保留，界面明确提示；外部记忆服务的删除排队，并提示待联网处理。媒体占用或日程设置写入失败单独返回警告，不假称全部物理痕迹已清除。

## 链路与并发边界

| 入口 | 实现及保持的行为 | 验证 |
| --- | --- | --- |
| JSON → 角色文件 → 选择器 | 验证 id/name/persona 和字段类型，逐文件成功/跳过/错误，使用原有独占创建 | 22 张原卡实际 HTTP 导入、重复、非法输入、长字段/metadata roundtrip |
| 导出 → 浏览器下载 | 原生 JSON，仅已保存共享设定，文件名由 id 生成 | HTTP 内容/下载头与隐私排除断言；浏览器脚本已提供 |
| 删除 → 活跃角色 → 旧数据 | 默认保留，删除活跃角色后选择可用角色；清数据按角色归属删除 | 两种删除、同 ID 重导、数据库关闭重开、同 QQ 会话其他角色隔离 |
| 删除 → 模型/投递/后台消费者 | `meta` 保存角色独立 generation；模型调用与归档、反思、日记、日常、语义评估分别捕获并在消费提交前校验；不递增共用 QQ scope | 实际模型 HTTP 延迟返回时删除+同 ID 重导；旧回复不发送、不落库、不补记模型用量；独立review的消费者提交窗口专项另见下文 |
| 已开始投递 → 删除 | 等待该角色已交给协议的发送；删除期间拒绝 load/save/import/clone 同 ID | 可控发送闸门测试 |
| 主动生成 → 删除 → 主动发送 | compose 携带角色及 generation，经所有主动发送入口传递；followup 同步携带 | QQ/本地 compose 后删除，deliver 不转用新角色，不发送、不写出站记录 |
| 清理异常 → 重试 | DB 与卡删除在事务边界中协调；异常恢复卡和 active 配置，保留数据可重试 | 用 SQLite 触发器注入删除失败，断言原卡/记忆/active 保留，移除故障后重试成功 |
| 慢导入 → 用户切编辑 | 只更新列表，不加载导入卡、不重绘表单；列表刷新有请求代次保护 | 浏览器脚本包含延迟响应、切角色、输入新草稿后的检查 |

新增运行模块：`lib/character-cards.mjs`、`lib/ui-character-cards.mjs`。其余必要修改：`config.mjs`、`api.mjs`、`ui-app.mjs`、`scope-lifecycle.mjs`、`llm.mjs`、`chat.mjs`、`scheduler.mjs`、`life.mjs`、`extended-memory.mjs`、`cognition.mjs`。无新表，无数据库版本变更；角色 generation 复用持久 meta。清除数据时同步删除对应 `daily-source` 中的第一人称经历正文，保留其他角色记录。

## 已运行的检查

```text
node --test --test-reporter=tap tools/character-cards-test.mjs
9 tests / 9 pass / 0 fail / 0 skip

node --test --test-reporter=tap tools/life-continuity-test.mjs tools/record-continuity-test.mjs tools/next-version-test.mjs
73 tests / 73 pass / 0 fail / 0 skip
```

专项支持 `HEARTECHO_TEST_APP_ROOT`，浏览器专项另支持 `HEARTECHO_TEST_EDITION`。源码语法检查通过。主任务整体验收日志另见 `build/dev18-source-core.log` 与 `build/dev18-platform-retry.log`，此处不将其数量重复计为专项证据。

独立review用真实 LlmGateway 完成请求后暂停消费者，在删除+同 ID 重导后放行，确定旧归档与新版每日归档会回填各一行（`build/dev18-delete-writeback-before.log`）。据此将角色 generation 校验扩展到消费者的持久化提交位置。修补后角色专项+生命/记录/next 共82项通过，见 `build/dev18-character-consumers.log`；独立review专项 `tools/character-delete-writeback-test.mjs` 扩展到旧归档、新版每日归档、日记及反思的保留/清数据边界，共6/6通过，见 `build/dev18-delete-writeback-expanded.log`。最新角色专项9/9见 `build/dev18-characters-final.log`。

## 浏览器与外部边界

`tools/character-cards-browser-test.mjs` 使用隔离实际应用、模拟模型、真实浏览器文件选择及下载，覆盖通用/TB 两版、取消/保留/清数据删除、重导恢复、慢导入切角色保草稿、页面重载。子任务首次沙箱执行两版均因 `CDP timeout Runtime.enable` 在产品交互前失败。主任务外沙箱统一执行后通用版通过，TB版在聊天回复等待超时；检查发现脚本只等待输入框而未等待 `nativeSend` 所需的当前角色历史就绪，已收紧页面就绪条件，最终复跑结果由主任务补充，未用改动产品逻辑掩盖脚本等待问题。

未连接真实 QQ、付费模型、外部 Hindsight 服务；远端实际删除只验证本地持久删除队列。备份、无法确定角色归属的旧记录和已交给协议发送的消息无法通过删卡撤回。

## 最终验收补充

主任务统一复跑后，通用/TB角色卡浏览器2/2通过，见 `build/dev18-regression-final.json`。最终exe解出的两版程序各通过49项，其中包含角色卡浏览器、9项角色API和6项消费者删除窗口；见 `build/dev18-payload-generic.log` 与 `build/dev18-payload-tb.log`。删除确认截图等待淡入完成后重新采集，两版2/2通过；主任务目视确认文字、两种删除选项与确认按钮清晰。
