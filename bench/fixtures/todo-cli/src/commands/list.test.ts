import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runList } from './list.ts';
import { addTodo, emptyState, markDone } from '../model/todo.ts';
import { saveState } from '../store/store.ts';

let root: string;
let dir: string;
let file: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'todo-list-'));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  dir = mkdtempSync(join(root, 'case-'));
  file = join(dir, 'todos.json');
});

describe('runList 输出', () => {
  it('有待办时逐行显示编号、完成标记和标题', () => {
    let state = emptyState();
    state = addTodo(state, '买牛奶');
    state = addTodo(state, '写报告');
    state = addTodo(state, '寄信');
    state = markDone(state, 2);
    saveState(dir, state);

    const lines = runList(dir).split('\n');
    assert.equal(lines.length, 4);
    assert.match(lines[0], /^1 \[ \] 买牛奶$/);
    assert.match(lines[1], /^2 \[x\] 写报告$/);
    assert.match(lines[2], /^3 \[ \] 寄信$/);
    assert.equal(lines[3], '共 3 项，已完成 1 项。');
  });

  it('全部未完成时统计已完成 0 项', () => {
    saveState(dir, addTodo(emptyState(), '买牛奶'));
    assert.equal(runList(dir), '1 [ ] 买牛奶\n共 1 项，已完成 0 项。');
  });

  it('全部完成时统计所有已完成项', () => {
    let state = addTodo(emptyState(), '买牛奶');
    state = addTodo(state, '写报告');
    state = markDone(markDone(state, 1), 2);
    saveState(dir, state);
    assert.equal(runList(dir), '1 [x] 买牛奶\n2 [x] 写报告\n共 2 项，已完成 2 项。');
  });

  it('待办列表为空时返回「暂无待办」', () => {
    saveState(dir, emptyState());
    assert.equal(runList(dir), '暂无待办');
  });

  it('todos.json 不存在时返回「暂无待办」', () => {
    assert.equal(existsSync(file), false);
    assert.equal(runList(dir), '暂无待办');
  });
});

describe('runList 只读行为', () => {
  it('执行前后 todos.json 内容不变', () => {
    let state = emptyState();
    state = addTodo(state, '买牛奶');
    state = addTodo(state, '写报告');
    state = markDone(state, 1);
    saveState(dir, state);

    const before = readFileSync(file, 'utf8');
    runList(dir);
    const after = readFileSync(file, 'utf8');
    assert.equal(after, before);
  });

  it('todos.json 不存在时不会创建该文件', () => {
    runList(dir);
    assert.equal(existsSync(file), false);
  });
});
