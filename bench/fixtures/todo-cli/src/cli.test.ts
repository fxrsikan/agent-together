import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));

let root: string;
let dir: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'todo-cli-'));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  // 每个用例使用独立的工作目录，todos.json 写在其中。
  dir = mkdtempSync(join(root, 'case-'));
});

function run(...args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir,
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('todo add / list', () => {
  it('add 输出确认信息并以 0 退出，随后 list 能看到该待办', () => {
    const added = run('add', '买牛奶');
    assert.equal(added.status, 0);
    assert.equal(added.stdout, '已添加待办 1：买牛奶\n');
    assert.equal(added.stderr, '');

    const listed = run('list');
    assert.equal(listed.status, 0);
    assert.equal(listed.stdout, '1 [ ] 买牛奶\n共 1 项，已完成 0 项。\n');
  });

  it('标题由多个参数拼接而成', () => {
    const added = run('add', '买', '牛奶');
    assert.equal(added.status, 0);
    assert.equal(added.stdout, '已添加待办 1：买 牛奶\n');
  });

  it('没有待办时 list 显示暂无待办', () => {
    const listed = run('list');
    assert.equal(listed.status, 0);
    assert.equal(listed.stdout, '暂无待办\n');
  });
});

describe('todo done / rm', () => {
  it('done 标记完成，list 显示 [x]', () => {
    run('add', '买牛奶');
    const done = run('done', '1');
    assert.equal(done.status, 0);
    assert.equal(done.stdout, '已完成 #1\n');
    assert.equal(run('list').stdout, '1 [x] 买牛奶\n共 1 项，已完成 1 项。\n');
  });

  it('rm 删除后 list 不再显示，且新待办编号不复用', () => {
    run('add', '买牛奶');
    run('add', '写报告');
    const removed = run('rm', '1');
    assert.equal(removed.status, 0);
    assert.equal(removed.stdout, '已删除 #1\n');
    assert.equal(run('list').stdout, '2 [ ] 写报告\n共 1 项，已完成 0 项。\n');

    assert.equal(run('add', '寄信').stdout, '已添加待办 3：寄信\n');
  });
});

describe('用法与错误', () => {
  it('没有子命令时打印用法并以非 0 退出', () => {
    const result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /用法：todo/);
    assert.equal(result.stdout, '');
  });

  it('未知子命令时打印用法并以非 0 退出', () => {
    const result = run('frobnicate');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /用法：todo/);
    assert.equal(result.stdout, '');
  });

  it('子命令出错时错误信息输出到 stderr、退出码为 1，且不打印堆栈', () => {
    const result = run('done', '99');
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '未找到编号 99\n');
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  });

  it('缺少编号参数时报错并以 1 退出', () => {
    const result = run('rm');
    assert.equal(result.status, 1);
    assert.equal(result.stderr, '请提供待办编号\n');
  });

  it('编号无效时报错并以 1 退出', () => {
    const result = run('done', 'abc');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /编号无效/);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  });
});
