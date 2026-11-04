import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDone } from './done.ts';
import { addTodo, formatList, emptyState, type TodoState } from '../model/todo.ts';
import { loadState, saveState } from '../store/store.ts';

let root: string;
let dir: string;
let file: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'todo-done-'));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  dir = mkdtempSync(join(root, 'case-'));
  file = join(dir, 'todos.json');
});

function readState(): TodoState {
  return JSON.parse(readFileSync(file, 'utf8')) as TodoState;
}

/** 通过模型与存储依赖准备三条待办（编号 1、2、3），不引用其他命令。 */
function seedThreeTodos(): void {
  let state = emptyState();
  state = addTodo(state, '买牛奶');
  state = addTodo(state, '写报告');
  state = addTodo(state, '寄信');
  saveState(dir, state);
}

describe('runDone 状态变化', () => {
  it('把指定编号的待办标记为完成并返回确认文本，其他待办不变', () => {
    seedThreeTodos();

    const message = runDone(['2'], dir);

    assert.equal(message, '已完成 #2');
    assert.deepEqual(readState(), {
      lastId: 3,
      todos: [
        { id: 1, title: '买牛奶', done: false },
        { id: 2, title: '写报告', done: true },
        { id: 3, title: '寄信', done: false },
      ],
    });
  });

  it('完成后列表显示 [x]', () => {
    seedThreeTodos();

    runDone(['2'], dir);

    assert.equal(
      formatList(loadState(dir).todos),
      ['1 [ ] 买牛奶', '2 [x] 写报告', '3 [ ] 寄信'].join('\n'),
    );
  });

  it('重复完成同一待办时提示已经是完成状态，且不写入 todos.json', () => {
    seedThreeTodos();

    runDone(['1'], dir);
    // 写入与 saveState 不同的合法 JSON，若再次写入会被覆盖成 pretty-print。
    const custom = `${JSON.stringify({
      lastId: 3,
      todos: [
        { id: 1, title: '买牛奶', done: true },
        { id: 2, title: '写报告', done: false },
        { id: 3, title: '寄信', done: false },
      ],
    })}\n`;
    writeFileSync(file, custom, 'utf8');

    const again = runDone(['1'], dir);

    assert.equal(again, '#1 已经是完成状态');
    assert.equal(readFileSync(file, 'utf8'), custom);
    assert.equal(readState().todos[0]?.done, true);
  });

  it('完成待办不改变 lastId，编号不会回退', () => {
    seedThreeTodos();

    runDone(['3'], dir);

    assert.equal(readState().lastId, 3);
  });
});

describe('runDone 错误分支', () => {
  it('缺少参数时抛出「请提供待办编号」，且不创建 todos.json', () => {
    assert.throws(() => runDone([], dir), { message: '请提供待办编号' });
    assert.equal(existsSync(file), false);
  });

  it('编号无效（如 abc）时抛出「编号无效」，且不修改已有的 todos.json', () => {
    seedThreeTodos();
    const original = readFileSync(file, 'utf8');

    assert.throws(() => runDone(['abc'], dir), { message: /编号无效/ });
    assert.equal(readFileSync(file, 'utf8'), original);
  });

  it('编号为 0 或负数时抛出「编号无效」', () => {
    seedThreeTodos();

    assert.throws(() => runDone(['0'], dir), { message: /编号无效/ });
    assert.throws(() => runDone(['-1'], dir), { message: /编号无效/ });
  });

  it('编号不存在时抛出「未找到编号」，且 todos.json 内容不变', () => {
    seedThreeTodos();
    const original = readFileSync(file, 'utf8');

    assert.throws(() => runDone(['99'], dir), { message: /未找到编号 99/ });
    assert.equal(readFileSync(file, 'utf8'), original);
  });

  it('已删除（不在列表中）的编号视为不存在，且不修改 todos.json', () => {
    writeFileSync(
      file,
      `${JSON.stringify({ lastId: 3, todos: [{ id: 1, title: '买牛奶', done: false }] }, null, 2)}\n`,
      'utf8',
    );
    const original = readFileSync(file, 'utf8');

    assert.throws(() => runDone(['2'], dir), { message: /未找到编号 2/ });
    assert.equal(readFileSync(file, 'utf8'), original);
  });

  it('文件缺失时（空状态）完成任何编号都抛出「未找到编号」，且不创建文件', () => {
    assert.throws(() => runDone(['1'], dir), { message: /未找到编号 1/ });
    assert.equal(existsSync(file), false);
  });
});
