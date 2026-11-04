// 待办模型：纯函数，不做任何 IO。所有函数都返回新状态，不修改传入的对象。

export interface Todo {
  id: number;
  title: string;
  done: boolean;
}

export interface TodoState {
  /** 曾经分配过的最大编号，即使对应待办已被删除也保留，保证编号不复用。 */
  lastId: number;
  todos: Todo[];
}

export function emptyState(): TodoState {
  return { lastId: 0, todos: [] };
}

/** 添加待办。新编号 = max(lastId, 现有最大编号) + 1。 */
export function addTodo(state: TodoState, title: string): TodoState {
  const maxExisting = state.todos.reduce((max, todo) => Math.max(max, todo.id), 0);
  const id = Math.max(state.lastId, maxExisting) + 1;
  return {
    lastId: id,
    todos: [...state.todos, { id, title, done: false }],
  };
}

/** 将指定编号的待办标记为已完成。编号不存在时抛出错误。 */
export function markDone(state: TodoState, id: number): TodoState {
  assertExists(state, id);
  return {
    lastId: state.lastId,
    todos: state.todos.map((todo) => (todo.id === id ? { ...todo, done: true } : { ...todo })),
  };
}

/** 删除指定编号的待办。编号不存在时抛出错误；lastId 保持不变，因此编号不会被复用。 */
export function removeTodo(state: TodoState, id: number): TodoState {
  assertExists(state, id);
  return {
    lastId: state.lastId,
    todos: state.todos.filter((todo) => todo.id !== id).map((todo) => ({ ...todo })),
  };
}

/** 每行格式：`<编号> [x] <标题>` 或 `<编号> [ ] <标题>`；没有待办时返回「暂无待办」。 */
export function formatList(todos: readonly Todo[]): string {
  if (todos.length === 0) {
    return '暂无待办';
  }
  return todos
    .map((todo) => `${todo.id} ${todo.done ? '[x]' : '[ ]'} ${todo.title}`)
    .join('\n');
}

/** 解析用户输入的编号：只接受十进制正整数字符串，如 '1'、'12'。 */
export function parseId(input: string): number {
  if (!/^[1-9]\d*$/.test(input)) {
    throw new Error(`编号无效：${JSON.stringify(input)}`);
  }
  const id = Number(input);
  if (!Number.isSafeInteger(id)) {
    throw new Error(`编号无效：${JSON.stringify(input)}`);
  }
  return id;
}

function assertExists(state: TodoState, id: number): void {
  if (!state.todos.some((todo) => todo.id === id)) {
    throw new Error(`未找到编号 ${id}`);
  }
}
