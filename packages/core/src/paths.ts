import path from "node:path";

/** Project-relative posix path, or null when the file lies outside the project. */
export function relativeToRoot(root: string, file: string): string | null {
  const rel = path.relative(root, path.resolve(root, file));
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}
