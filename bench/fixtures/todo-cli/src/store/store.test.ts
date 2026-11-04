import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadState, saveState } from './store.ts';
import type { TodoState } from '../model/todo.ts';

let root: string;
let dir: string;
let file: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'todo-store-'));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  dir = mkdtempSync(join(root, 'case-'));
  file = join(dir, 'todos.json');
});

describe('loadState 缺失文件', () => {
  it('文件不存在时返回空状态', () => {
    assert.deepEqual(loadState(dir), { lastId: 0, todos: [] });
  });

  it('文件不存在时不创建文件', () => {
    loadState(dir);
    assert.equal(existsSync(file), false);
  });
});

describe('saveState / loadState 往返', () => {
  it('保存后读取得到结构相等的状态', () => {
    const state: TodoState = {
      lastId: 3,
      todos: [
        { id: 1, title: '买牛奶', done: true },
        { id: 3, title: 'write tests "quoted" \\ 中文 😀', done: false },
      ],
    };
    saveState(dir, state);
    assert.deepEqual(loadState(dir), state);
  });

  it('写入的文件是 UTF-8 编码的 JSON', () => {
    saveState(dir, { lastId: 1, todos: [{ id: 1, title: '中文标题', done: false }] });
    const text = readFileSync(file, 'utf8');
    assert.deepEqual(JSON.parse(text), {
      lastId: 1,
      todos: [{ id: 1, title: '中文标题', done: false }],
    });
  });

  it('覆盖已有文件时以新状态为准', () => {
    saveState(dir, { lastId: 2, todos: [{ id: 1, title: 'a', done: false }, { id: 2, title: 'b', done: false }] });
    saveState(dir, { lastId: 2, todos: [{ id: 2, title: 'b', done: true }] });
    assert.deepEqual(loadState(dir), { lastId: 2, todos: [{ id: 2, title: 'b', done: true }] });
  });

  it('保存空状态后仍保留 lastId（编号不复用）', () => {
    saveState(dir, { lastId: 5, todos: [] });
    assert.deepEqual(loadState(dir), { lastId: 5, todos: [] });
  });

  it('拒绝保存结构不合法的状态，且不写文件', () => {
    const invalid = { lastId: -1, todos: [] } as unknown as TodoState;
    assert.throws(() => saveState(dir, invalid), (error: Error) => error.message.includes(file));
    assert.equal(existsSync(file), false);
  });
});

describe('loadState 损坏文件', () => {
  it('内容不是合法 JSON 时抛出包含文件路径的错误', () => {
    writeFileSync(file, '{ not json', 'utf8');
    assert.throws(() => loadState(dir), (error: Error) => error.message.includes(file));
  });

  it('不覆盖损坏的文件', () => {
    writeFileSync(file, '{ not json', 'utf8');
    assert.throws(() => loadState(dir));
    assert.equal(readFileSync(file, 'utf8'), '{ not json');
  });

  it('顶层不是对象时抛出包含文件路径的错误', () => {
    writeFileSync(file, '[]', 'utf8');
    assert.throws(() => loadState(dir), (error: Error) => error.message.includes(file));
  });

  it('缺少 lastId 时抛出包含文件路径的错误', () => {
    writeFileSync(file, JSON.stringify({ todos: [] }), 'utf8');
    assert.throws(() => loadState(dir), (error: Error) => error.message.includes(file) && error.message.includes('lastId'));
  });

  it('缺少 todos 时抛出包含文件路径的错误', () => {
    writeFileSync(file, JSON.stringify({ lastId: 0 }), 'utf8');
    assert.throws(() => loadState(dir), (error: Error) => error.message.includes(file) && error.message.includes('todos'));
  });

  it('lastId 为负数、小数或字符串时抛出错误', () => {
    for (const lastId of [-1, 1.5, '1']) {
      writeFileSync(file, JSON.stringify({ lastId, todos: [] }), 'utf8');
      assert.throws(() => loadState(dir), (error: Error) => error.message.includes(file), `lastId=${String(lastId)}`);
    }
  });

  it('todos 不是数组时抛出错误', () => {
    writeFileSync(file, JSON.stringify({ lastId: 0, todos: {} }), 'utf8');
    assert.throws(() => loadState(dir), (error: Error) => error.message.includes(file));
  });

  it('todo 项字段类型错误时抛出错误', () => {
    const badItems = [
      { id: '1', title: 'a', done: false },
      { id: 1.5, title: 'a', done: false },
      { id: 1, title: 42, done: false },
      { id: 1, title: 'a', done: 'no' },
      { id: 1, title: 'a' },
      null,
    ];
    for (const item of badItems) {
      writeFileSync(file, JSON.stringify({ lastId: 1, todos: [item] }), 'utf8');
      assert.throws(() => loadState(dir), (error: Error) => error.message.includes(file), JSON.stringify(item));
    }
  });
});
