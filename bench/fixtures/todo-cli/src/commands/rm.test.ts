import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRm } from './rm.ts';
import { addTodo, formatList, emptyState, type TodoState } from '../model/todo.ts';
import { loadState, saveState } from '../store/store.ts';

let root: string;
let dir: string;
let file: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'todo-rm-'));
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

describe('runRm 正常删除', () => {
  it('删除指定编号的待办并返回确认文本，其他待办不变', () => {
    seedThreeTodos();

    const message = runRm(['1'], dir);

    assert.equal(message, '已删除 #1');
    assert.deepEqual(readState(), {
      lastId: 3,
      todos: [
        { id: 2, title: '写报告', done: false },
        { id: 3, title: '寄信', done: false },
      ],
    });
  });

  it('删除后列表不再包含该待办', () => {
    seedThreeTodos();

    runRm(['2'], dir);

    assert.equal(
      formatList(loadState(dir).todos),
      ['1 [ ] 买牛奶', '3 [ ] 寄信'].join('\n'),
    );
  });

  it('删除已完成的待办同样生效', () => {
    seedThreeTodos();
    saveState(dir, {
      lastId: 3,
      todos: [
        { id: 1, title: '买牛奶', done: true },
        { id: 2, title: '写报告', done: false },
        { id: 3, title: '寄信', done: false },
      ],
    });

    runRm(['1'], dir);

    assert.deepEqual(
      readState().todos.map((todo) => todo.id),
      [2, 3],
    );
  });
});

describe('runRm 编号不复用', () => {
  it('删除编号最大的待办后再新增，新编号不等于被删除的编号', () => {
    seedThreeTodos();

    runRm(['3'], dir);
    const added = addTodo(loadState(dir), '新待办');
    saveState(dir, added);

    const newTodo = added.todos.find((todo) => todo.title === '新待办');
    assert.notEqual(newTodo?.id, 3);
    assert.equal(newTodo?.id, 4);
  });

  it('删除后 lastId 保持不变', () => {
    seedThreeTodos();

    runRm(['3'], dir);

    assert.equal(readState().lastId, 3);
  });

  it('删除所有待办后再新增，编号仍接着之前的最大编号递增', () => {
    seedThreeTodos();

    runRm(['1'], dir);
    runRm(['2'], dir);
    runRm(['3'], dir);
    saveState(dir, addTodo(loadState(dir), '又一个'));

    assert.deepEqual(readState(), {
      lastId: 4,
      todos: [{ id: 4, title: '又一个', done: false }],
    });
  });
});

describe('runRm 错误分支', () => {
  it('缺少参数时抛出「请提供待办编号」，且不创建 todos.json', () => {
    assert.throws(() => runRm([], dir), { message: '请提供待办编号' });
    assert.equal(existsSync(file), false);
  });

  it('编号无效（如 abc）时抛出「编号无效」，且 todos.json 内容不变', () => {
    seedThreeTodos();
    const original = readFileSync(file, 'utf8');

    assert.throws(() => runRm(['abc'], dir), { message: /编号无效/ });
    assert.equal(readFileSync(file, 'utf8'), original);
  });

  it('编号为 0 或负数时抛出「编号无效」，且 todos.json 内容不变', () => {
    seedThreeTodos();
    const original = readFileSync(file, 'utf8');

    assert.throws(() => runRm(['0'], dir), { message: /编号无效/ });
    assert.throws(() => runRm(['-1'], dir), { message: /编号无效/ });
    assert.equal(readFileSync(file, 'utf8'), original);
  });

  it('编号不存在时抛出「未找到编号」，且 todos.json 内容不变', () => {
    seedThreeTodos();
    const original = readFileSync(file, 'utf8');

    assert.throws(() => runRm(['99'], dir), { message: /未找到编号 99/ });
    assert.equal(readFileSync(file, 'utf8'), original);
  });

  it('已删除的编号再次删除时抛出「未找到编号」，且 todos.json 内容不变', () => {
    seedThreeTodos();
    runRm(['2'], dir);
    const original = readFileSync(file, 'utf8');

    assert.throws(() => runRm(['2'], dir), { message: /未找到编号 2/ });
    assert.equal(readFileSync(file, 'utf8'), original);
  });

  it('文件缺失时（空状态）删除任何编号都抛出「未找到编号」，且不创建文件', () => {
    assert.throws(() => runRm(['1'], dir), { message: /未找到编号 1/ });
    assert.equal(existsSync(file), false);
  });

  it('文件损坏时报错而不覆盖文件', () => {
    writeFileSync(file, '{ 不是合法的 json', 'utf8');
    const original = readFileSync(file, 'utf8');

    assert.throws(() => runRm(['1'], dir), { message: /不是合法的 JSON/ });
    assert.equal(readFileSync(file, 'utf8'), original);
  });
});
