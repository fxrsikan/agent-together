// todo rm <编号>：删除指定编号的待办，并返回确认信息。
// 只依赖数据存储的 loadState/saveState 与待办模型的 parseId/removeTodo。
// 删除不会修改 lastId，因此被删除的编号不会被后续新待办复用。

import { parseId, removeTodo } from '../model/todo.ts';
import { loadState, saveState } from '../store/store.ts';

/**
 * 删除 args[0] 指定编号的待办。
 * 缺少参数时抛出「请提供待办编号」；编号无效时抛出「编号无效」（来自 parseId）；
 * 编号不存在时抛出「未找到编号」（来自 removeTodo）。出错时都不修改 todos.json。
 */
export function runRm(args: readonly string[], dir: string): string {
  const input = args[0];
  if (input === undefined) {
    throw new Error('请提供待办编号');
  }

  const id = parseId(input);
  const next = removeTodo(loadState(dir), id);
  saveState(dir, next);
  return `已删除 #${id}`;
}
