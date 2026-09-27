// 聊天生图进行中状态注册表(v1.9)。
// 宿主是唯一知道生成起止与产出路径的地方;客户端轮询
// /dsh-canvas/generation-status 拿这份快照,驱动「生成中占位提示」与
// 「完成后自动上画布」——只认这里登记的路径,read_image 等工具结果里
// 提到的旧文件永远不会被误判为本轮产出。
const chatGeneration = { active: 0, completed: [] };
const CHAT_GENERATION_COMPLETED_MAX = 50;

/** 生成开始:active +1。与 endGeneration 成对(调用方须在 finally 里结束)。 */
export function beginChatGeneration() {
  chatGeneration.active += 1;
}

/** 生成结束:active -1,下限 0(防御重复调用)。 */
export function endChatGeneration() {
  chatGeneration.active = Math.max(0, chatGeneration.active - 1);
}

/** 登记一条已落盘的本轮产出路径(环形上限 50 条,防无界增长)。 */
export function noteChatGenerationCompleted(path) {
  chatGeneration.completed.push({ path, at: Date.now() });
  if (chatGeneration.completed.length > CHAT_GENERATION_COMPLETED_MAX) {
    chatGeneration.completed.splice(0, chatGeneration.completed.length - CHAT_GENERATION_COMPLETED_MAX);
  }
}

/** 当前快照(浅拷贝,调用方改不动内部状态)。 */
export function chatGenerationStatus() {
  return { active: chatGeneration.active, completed: [...chatGeneration.completed] };
}
