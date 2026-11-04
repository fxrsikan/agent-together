// todo 命令入口：解析 argv，分发到各子命令，统一输出结果、错误与退出码。
// 只依赖各子命令的 runAdd/runList/runDone/runRm 对外接口。

import { pathToFileURL } from 'node:url';
import { runAdd } from './commands/add.ts';
import { runList } from './commands/list.ts';
import { runDone } from './commands/done.ts';
import { runRm } from './commands/rm.ts';

export const USAGE = [
  '用法：todo <命令> [参数]',
  '',
  '命令：',
  '  add <标题>    添加待办',
  '  list          列出所有待办',
  '  done <编号>   将指定编号的待办标记为完成',
  '  rm <编号>     删除指定编号的待办',
].join('\n');

/**
 * 按第一个参数分发到子命令，并返回退出码。
 * 成功时把结果写到 stdout 并返回 0；未知或缺失的子命令打印用法并返回 1；
 * 子命令抛出的错误只把错误信息写到 stderr（不含堆栈）并返回 1。
 * dir 为待办数据所在目录（todos.json 所在目录）。
 */
export function main(argv: readonly string[], dir: string): number {
  const [command, ...args] = argv;

  try {
    switch (command) {
      case 'add':
        return output(runAdd(args, dir));
      case 'list':
        return output(runList(dir));
      case 'done':
        return output(runDone(args, dir));
      case 'rm':
        return output(runRm(args, dir));
      default:
        process.stderr.write(`${USAGE}\n`);
        return 1;
    }
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    return 1;
  }
}

function output(text: string): number {
  process.stdout.write(`${text}\n`);
  return 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 仅当本文件被直接运行（node src/cli.ts ...）时执行；被 import 时不执行，便于测试导入。
const isDirectRun =
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isDirectRun) {
  process.exitCode = main(process.argv.slice(2), process.cwd());
}
