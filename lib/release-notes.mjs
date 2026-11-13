import { APP_VERSION } from "./version.mjs";

// 只维护当前版本；历史说明保留在 GitHub 发布记录中。
export const releaseNotes = {
  version: APP_VERSION,
  title: "本次更新",
  body: "• 角色工作室支持快捷导入、导出和删除角色卡，删除时可选择是否保留聊天与记忆。\n• 修复回复中偶发出现的 [::thought]:: 等内部标记。\n• 更新公告只显示本版变化，新增箭头与高亮引导，帮助你找到新功能。",
  guide: "character-cards",
};
