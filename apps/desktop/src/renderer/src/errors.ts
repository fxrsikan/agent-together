const PLAIN: [RegExp, string][] = [
  [/\bENOENT\b/, "找不到这个文件或文件夹"],
  [/\b(EACCES|EPERM)\b/, "没有权限访问这个文件或文件夹"],
  [/\bEBUSY\b/, "文件正被别的程序占用，关掉它再试"],
  [/\bENOSPC\b/, "磁盘空间不够了"],
  [/\bETIMEDOUT\b|timed out/i, "等太久没有响应"],
];

/**
 * An error as the user should read it: without Electron's IPC prefix, and with
 * common system errors put plainly (the original stays in parentheses for help requests).
 */
export function errorText(err: unknown): string {
  const raw = (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
  const plain = PLAIN.find(([re]) => re.test(raw))?.[1];
  return plain ? `${plain}（${raw.split("\n")[0]}）` : raw;
}
