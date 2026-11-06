import path from "node:path";

/**
 * File names from a git command run with `-z`. Without `-z` git escapes names
 * with non-ASCII characters ("src/\344\275\240.ts", quoted), so every git
 * command that lists files must use `-z` and read its output with these.
 */
export function zNames(out: string): string[] {
  return out.split("\0").filter(Boolean);
}

/** `--numstat -z` output: "added\tremoved\tpath\0" per file ("-" counts for binary files). */
export function zNumstat(out: string): { path: string; added: number; removed: number }[] {
  const parts = out.split("\0");
  const files: { path: string; added: number; removed: number }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const m = /^\s*(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(parts[i]);
    if (!m) continue;
    // A rename comes as "added\tremoved\t\0old\0new": keep the new name.
    const name = m[3] !== "" ? m[3] : ((i += 2), parts[i]);
    if (name) files.push({ path: name, added: Number(m[1]) || 0, removed: Number(m[2]) || 0 });
  }
  return files;
}

/** Project-relative posix path, or null when the file lies outside the project. */
export function relativeToRoot(root: string, file: string): string | null {
  const rel = path.relative(root, path.resolve(root, file));
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}
