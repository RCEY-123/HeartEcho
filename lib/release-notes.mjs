import { APP_VERSION } from "./version.mjs";

export const releaseNotes = {
  version: APP_VERSION,
  title: "SnowLuma 自动连接与后台运行",
  body: "• 自动读取所选协议端目录中当前 QQ 账号的本机端口、路径和令牌，修复导入后端口不一致。\n• 修复 Node 内置 WebSocket 的认证方式；支持 WebSocket 与 HTTP 分别使用不同令牌。\n• 点击检查或重连后立即使用新连接配置，避免继续连接旧端口。\n• 完成 SnowLuma 首次设置后自动隐藏已确认的独立启动器窗口；新增隐藏/显示控制台入口，后台继续运行。\n• 心语启动协议端时不分配新控制台，日志仍可在运行环境中查看。\n• 保留旧角色、对话、记忆、生命计划与 API Key；通用版和 TB 版独立覆盖升级，无需重新导入。",
};
