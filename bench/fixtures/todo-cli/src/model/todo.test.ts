import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addTodo,
  emptyState,
  formatList,
  markDone,
  parseId,
  removeTodo,
} from './todo.ts';
import type { Todo, TodoState } from './todo.ts';

describe('emptyState', () => {
  it('返回 lastId 为 0、没有待办的状态', () => {
    assert.deepEqual(emptyState(), { lastId: 0, todos: [] });
  });
});

describe('addTodo 编号分配', () => {
  it('在空状态下分配编号 1', () => {
    const state = addTodo(emptyState(), '买牛奶');
    assert.deepEqual(state, {
      lastId: 1,
      todos: [{ id: 1, title: '买牛奶', done: false }],
    });
  });

  it('之后按顺序递增编号', () => {
    let state = emptyState();
    state = addTodo(state, 'a');
    state = addTodo(state, 'b');
    state = addTodo(state, 'c');
    assert.deepEqual(
      state.todos.map((t) => t.id),
      [1, 2, 3],
    );
    assert.equal(state.lastId, 3);
  });

  it('删除编号最大的待办后，新编号也不复用', () => {
    let state = emptyState();
    state = addTodo(state, 'a');
    state = addTodo(state, 'b');
    state = removeTodo(state, 2);
    state = addTodo(state, 'c');
    assert.deepEqual(
      state.todos.map((t) => t.id),
      [1, 3],
    );
  });

  it('删除全部待办后，新编号仍然不从 1 重新开始', () => {
    let state = emptyState();
    state = addTodo(state, 'a');
    state = removeTodo(state, 1);
    state = addTodo(state, 'b');
    assert.deepEqual(state.todos, [{ id: 2, title: 'b', done: false }]);
  });

  it('不修改传入的状态对象', () => {
    const before = addTodo(emptyState(), 'a');
    const snapshot = structuredClone(before);
    addTodo(before, 'b');
    assert.deepEqual(before, snapshot);
  });
});

describe('markDone', () => {
  it('将指定编号的待办标记为完成，并返回新状态', () => {
    const before = addTodo(addTodo(emptyState(), 'a'), 'b');
    const after = markDone(before, 2);
    assert.deepEqual(after.todos, [
      { id: 1, title: 'a', done: false },
      { id: 2, title: 'b', done: true },
    ]);
    assert.equal(after.lastId, before.lastId);
  });

  it('不修改传入的状态对象', () => {
    const before = addTodo(emptyState(), 'a');
    const snapshot = structuredClone(before);
    markDone(before, 1);
    assert.deepEqual(before, snapshot);
  });

  it('编号不存在时抛出包含「未找到编号 X」的错误', () => {
    const state = addTodo(emptyState(), 'a');
    assert.throws(() => markDone(state, 99), /未找到编号 99/);
  });

  it('空状态下标记任何编号都抛出错误', () => {
    assert.throws(() => markDone(emptyState(), 1), /未找到编号 1/);
  });
});

describe('removeTodo', () => {
  it('删除指定编号的待办，并返回新状态', () => {
    const before = addTodo(addTodo(emptyState(), 'a'), 'b');
    const after = removeTodo(before, 1);
    assert.deepEqual(after, {
      lastId: 2,
      todos: [{ id: 2, title: 'b', done: false }],
    });
  });

  it('不修改传入的状态对象', () => {
    const before = addTodo(addTodo(emptyState(), 'a'), 'b');
    const snapshot = structuredClone(before);
    removeTodo(before, 1);
    assert.deepEqual(before, snapshot);
  });

  it('编号不存在时抛出包含「未找到编号 X」的错误', () => {
    const state = addTodo(emptyState(), 'a');
    assert.throws(() => removeTodo(state, 5), /未找到编号 5/);
  });

  it('同一编号删除两次时第二次抛出错误', () => {
    const state = removeTodo(addTodo(emptyState(), 'a'), 1);
    assert.throws(() => removeTodo(state, 1), /未找到编号 1/);
  });
});

describe('formatList', () => {
  it('没有待办时返回「暂无待办」', () => {
    assert.equal(formatList([]), '暂无待办');
  });

  it('每行包含编号、完成标记和标题', () => {
    const todos: Todo[] = [
      { id: 1, title: '买牛奶', done: false },
      { id: 12, title: '写报告', done: true },
    ];
    assert.equal(formatList(todos), '1 [ ] 买牛奶\n12 [x] 写报告');
  });

  it('只有一条待办时不带换行', () => {
    assert.equal(formatList([{ id: 3, title: 'x', done: false }]), '3 [ ] x');
  });

  it('接受 TodoState.todos 的结果', () => {
    const state: TodoState = addTodo(emptyState(), '锻炼');
    assert.equal(formatList(state.todos), '1 [ ] 锻炼');
  });
});

describe('parseId', () => {
  it('接受 "1" 与 "12"', () => {
    assert.equal(parseId('1'), 1);
    assert.equal(parseId('12'), 12);
  });

  it('接受很大的合法整数', () => {
    assert.equal(parseId('9007199254740991'), Number.MAX_SAFE_INTEGER);
  });

  for (const input of ['0', '-1', '1.5', 'abc', '', ' 1', '1 ', '01', '1e3', '0x10']) {
    it(`拒绝 ${JSON.stringify(input)} 并抛出「编号无效」`, () => {
      assert.throws(() => parseId(input), /编号无效/);
    });
  }

  it('超出安全整数范围时抛出「编号无效」', () => {
    assert.throws(() => parseId('9007199254740993'), /编号无效/);
  });
});
