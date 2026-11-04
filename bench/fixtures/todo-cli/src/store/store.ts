// 数据存储：把待办状态读写到指定目录下的 todos.json。
// 只依赖待办模型的类型与 emptyState()；文件缺失视为空状态，文件损坏则报错而不覆盖。

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emptyState } from '../model/todo.ts';
import type { Todo, TodoState } from '../model/todo.ts';

export const STATE_FILE_NAME = 'todos.json';

/** 读取 dir/todos.json。文件不存在时返回空状态且不创建文件；内容损坏或结构不符时抛出包含文件路径的错误。 */
export function loadState(dir: string): TodoState {
  const path = statePath(dir);
  if (!existsSync(path)) {
    return emptyState();
  }

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`无法读取数据文件 ${path}：${errorMessage(error)}`);
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`数据文件不是合法的 JSON：${path}（${errorMessage(error)}）`);
  }

  const problem = findProblem(data);
  if (problem !== undefined) {
    throw new Error(`数据文件结构不正确：${path}（${problem}）`);
  }
  return data as TodoState;
}

/** 将状态以 UTF-8 JSON 写入 dir/todos.json。状态结构不合法时抛出错误且不写文件。 */
export function saveState(dir: string, state: TodoState): void {
  const path = statePath(dir);
  const problem = findProblem(state);
  if (problem !== undefined) {
    throw new Error(`拒绝写入结构不正确的状态：${path}（${problem}）`);
  }

  // 先写临时文件再重命名，避免写到一半时留下残缺的 todos.json。
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(tempPath, path);
}

function statePath(dir: string): string {
  return join(dir, STATE_FILE_NAME);
}

/** 返回第一个结构问题的描述；结构合法时返回 undefined。 */
function findProblem(data: unknown): string | undefined {
  if (!isPlainObject(data)) {
    return '顶层必须是对象';
  }
  if (!('lastId' in data)) {
    return '缺少 lastId';
  }
  if (!('todos' in data)) {
    return '缺少 todos';
  }
  if (!isNonNegativeInteger(data.lastId)) {
    return 'lastId 必须是非负整数';
  }
  if (!Array.isArray(data.todos)) {
    return 'todos 必须是数组';
  }
  for (const [index, item] of data.todos.entries()) {
    const problem = findTodoProblem(item);
    if (problem !== undefined) {
      return `todos[${index}]：${problem}`;
    }
  }
  return undefined;
}

function findTodoProblem(item: unknown): string | undefined {
  if (!isPlainObject(item)) {
    return '必须是对象';
  }
  const todo = item as Partial<Record<keyof Todo, unknown>>;
  if (!Number.isSafeInteger(todo.id)) {
    return 'id 必须是整数';
  }
  if (typeof todo.title !== 'string') {
    return 'title 必须是字符串';
  }
  if (typeof todo.done !== 'boolean') {
    return 'done 必须是布尔值';
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
