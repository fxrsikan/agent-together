// todo done <编号>：把指定编号的待办标记为已完成，并返回确认信息。
// 只依赖数据存储的 loadState/saveState 与待办模型的 parseId/markDone。

import { markDone, parseId } from '../model/todo.ts';
import { loadState, saveState } from '../store/store.ts';

/**
 * 将 args[0] 指定编号的待办标记为完成。
 * 缺少参数时抛出「请提供待办编号」；编号无效时抛出「编号无效」（来自 parseId）；
 * 编号不存在时抛出「未找到编号」（来自 markDone）。出错时都不修改 todos.json。
 * 若该编号已经是完成状态，返回「#N 已经是完成状态」且不写入 todos.json。
 */
export function runDone(args: readonly string[], dir: string): string {
  const input = args[0];
  if (input === undefined) {
    throw new Error('请提供待办编号');
  }

  const id = parseId(input);
  const state = loadState(dir);
  const existing = state.todos.find((todo) => todo.id === id);
  if (existing?.done) {
    return `#${id} 已经是完成状态`;
  }

  const next = markDone(state, id);
  saveState(dir, next);
  return `已完成 #${id}`;
}
