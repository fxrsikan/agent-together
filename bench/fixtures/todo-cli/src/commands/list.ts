// todo list：读取待办并以编号、完成状态和标题逐行展示，返回展示文本。
// 只依赖数据存储的 loadState 与待办模型的 formatList；只读取数据，不写入 todos.json。

import { formatList } from '../model/todo.ts';
import { loadState } from '../store/store.ts';

/**
 * 读取 dir/todos.json 并返回待办列表文本。
 * 每行格式为「编号 [x]|[ ] 标题」，末行显示总数和已完成数；文件不存在或没有待办时返回「暂无待办」。
 * 文件损坏时抛出错误（来自 loadState），且不修改任何文件。
 */
export function runList(dir: string): string {
  const { todos } = loadState(dir);
  const list = formatList(todos);
  if (todos.length === 0) {
    return list;
  }
  const completed = todos.filter((todo) => todo.done).length;
  return `${list}\n共 ${todos.length} 项，已完成 ${completed} 项。`;
}
