# dev.18 回复标记修复与删除写回复核

## 回复标记

基线是 `1.3.0-dev.17.1` 源码副本。用户提供的 `[::thought` 换行 `]::` 会原样通过 `cleanReply`，随后进入分气泡、投递和历史。既有规则覆盖数字元标记和部分显式推理块，没有识别该通道标签。

`lib/util.mjs` 在分气泡之前移除完整的 `[::thought]::` 和 `[::thought::]` 标签。覆盖真实 LF/CRLF、字面 `\n` / `\r\n`、单个反斜杠后接真实换行、大小写与标签内部空白。只清除明确标签，保留后面的对白。普通括号、IPv6、引用、英文 thought、语义括号及原有推理块抑制均有回归断言。

最小命令：

```text
node --test --test-reporter=tap --test-name-pattern=thought tools/reply-integrity-test.mjs tools/conversation-flow-test.mjs tools/local-chat-test.mjs
```

修复前新增 5 项全部失败，修复后 5 项全部通过。证据为 `build/dev18-thought-before.log` 与 `build/dev18-thought-after.log`。用真实 ChatEngine 连接合成 QQ 投递服务，验证分泡开关下实际发送正文和 SQLite 记录；本地 HTTP 使用真实模型网关连接合成模型，验证历史 API、持久记录及下一轮请求上下文。

单个反斜杠加真实换行的补充样例也先失败后通过，见 `build/dev18-thought-line-continuation-before.log`（7/8）与 `build/dev18-thought-line-continuation-after.log`（8/8）。

相邻回归：

```text
node --test --test-reporter=tap tools/reply-integrity-test.mjs tools/conversation-flow-test.mjs tools/local-chat-test.mjs tools/life-continuity-test.mjs tools/record-continuity-test.mjs tools/next-version-test.mjs
```

结果为 127/127 通过，0 skip，见 `build/dev18-reply-regression.log`。此批在补充反斜杠变体前执行；补充后回复完整性 8 项已复跑通过。浏览器假模型已加入真实/字面转义 thought 标签，实际浏览器验证由主任务统一执行。本记录不将曾等待授权的浏览器调用计为通过。

不批量重写历史记录；不清空记忆。模型为什么生成该标记尚未通过真实付费服务确定，本修复解决它进入应用输出的清理缺口。

## 删除角色后的后台写回

独立审查发现：仅在模型网关检查角色是否仍有效，不能保证随后归档消费者的事务安全。已完成模型调用、尚未提交记忆时删除角色并以同 ID 重导，旧消费者仍可能把已删除内容写回来。

新增 `tools/character-delete-writeback-test.mjs`：用真实 `LlmGateway` 得到完整结果后，在消费者恢复前设可控阻塞点，执行完整删除和同 ID 重导，再恢复消费者。旧版归档回填 1 条 `memories`，新版归档回填 1 条 `hindsight_records`，两项均失败，见 `build/dev18-delete-writeback-before.log`。测试同时检查共享 QQ 会话的另一角色消息和会话代次保持。

角色管理实现补上生命周期检查后，原两项通过；另增加日记、反思在保留数据/全部删除两种模式下的相同窗口验证，6/6 通过。最终本文件加回复完整性测试 14/14，0 skip，见 `build/dev18-review-final.log`。测试支持 `HEARTECHO_TEST_APP_ROOT`，供最终安装负载执行。

审查涉及旧归档、新版每日归档、日记、反思、认知评估、独处日常、远端记忆同步和召回。实际消费者写回验证使用隔离目录、合成账号和假网络，不访问真实用户数据。远端服务/真实 QQ 的生产验收不包含在这些测试内。

最终主任务源码266项及聊天实际浏览器通过；最终安装包解出的通用/TB程序各49项通过，含回复完整性、6项消费者窗口及聊天实际浏览器。两版使用随包Node执行，输出与源码Hash核对一致，详见 `dev18-validation.md`。
