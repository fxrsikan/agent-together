// todo add <标题>：把标题存为新待办，并返回带编号的确认信息。
// 只依赖数据存储的 loadState/saveState 与待办模型的 addTodo。

import { addTodo } from '../model/todo.ts';
import { loadState, saveState } from '../store/store.ts';

/**
 * 添加一个待办。args 中的各项按空格拼接为标题，标题首尾空白会被去除。
 * 标题为空或全为空白时抛出错误，且不修改 todos.json。
 */
export function runAdd(args: readonly string[], dir: string): string {
  const title = args.join(' ').trim();
  if (title === '') {
    throw new Error('请提供待办标题');
  }

  const next = addTodo(loadState(dir), title);
  saveState(dir, next);
  return `已添加待办 ${next.lastId}：${title}`;
}
