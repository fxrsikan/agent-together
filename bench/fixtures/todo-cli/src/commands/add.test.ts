import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAdd } from './add.ts';
import type { TodoState } from '../model/todo.ts';

let root: string;
let dir: string;
let file: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'todo-add-'));
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

describe('runAdd 写入', () => {
  it('把多个参数拼接为标题写入 todos.json，并返回包含新编号的确认文本', () => {
    const message = runAdd(['买', '牛奶'], dir);

    assert.deepEqual(readState(), {
      lastId: 1,
      todos: [{ id: 1, title: '买 牛奶', done: false }],
    });
    assert.match(message, /1/);
    assert.match(message, /买 牛奶/);
  });

  it('去除标题首尾空白后再保存', () => {
    runAdd(['  ', '买', '牛奶  '], dir);

    assert.deepEqual(readState().todos, [{ id: 1, title: '买 牛奶', done: false }]);
  });
});

describe('runAdd 错误分支', () => {
  it('没有标题时抛出「请提供待办标题」，且不创建 todos.json', () => {
    assert.throws(() => runAdd([], dir), { message: '请提供待办标题' });
    assert.equal(existsSync(file), false);
  });

  it('标题全为空白时抛出「请提供待办标题」，且不修改已有的 todos.json', () => {
    const original = `${JSON.stringify({ lastId: 2, todos: [{ id: 2, title: '旧', done: true }] }, null, 2)}\n`;
    writeFileSync(file, original, 'utf8');

    assert.throws(() => runAdd(['  ', '\t'], dir), { message: '请提供待办标题' });
    assert.equal(readFileSync(file, 'utf8'), original);
  });
});

describe('runAdd 编号递增', () => {
  it('连续调用时编号严格递增为 1、2、3', () => {
    runAdd(['第一'], dir);
    const second = runAdd(['第二'], dir);
    const third = runAdd(['第三'], dir);

    assert.deepEqual(
      readState().todos.map((todo) => todo.id),
      [1, 2, 3],
    );
    assert.match(second, /2/);
    assert.match(third, /3/);
  });
});
