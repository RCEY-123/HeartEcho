import { APP_VERSION } from "./version.mjs";

export const releaseNotes = {
  version: APP_VERSION,
  title: "QQ 重启后的协议端自动接入修复",
  body: "• 保留 SnowLuma 自动端口/令牌对齐和后台运行功能。\n• 修复自动接入 QQ 关闭时反复提示端口未监听的问题，明确区分管理页面在线与账号已接入。\n• 新增「开启 QQ 自动接入并重连」，先备份原配置，保留其他设置；仅重启当前心语启动的协议进程。\n• 启动协议端时按已保存的自动接入设置运行，避免旧环境变量使设置失效。\n• 修复后 QQ 或协议端重启可自动恢复接入，保留角色、聊天、记忆与生命计划。",
};
