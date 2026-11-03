/** One file touched by a Codex apply_patch call, with the text it removes and adds. */
export interface PatchedFile {
  op: "add" | "update" | "delete";
  path: string;
  /** Destination when an update also renames the file ("*** Move to:"). */
  moveTo?: string;
  /** Context and removed lines of the hunks (what the file contained). */
  before: string;
  /** Context and added lines of the hunks (what it will contain). */
  after: string;
}

const HEADER = /^\*\*\* (Add|Update|Delete) File: (.+)$/;
const MOVE = /^\*\*\* Move to: (.+)$/;

/**
 * Parses the apply_patch envelope:
 *   *** Begin Patch / *** Add|Update|Delete File: <path> / [*** Move to: <path>] / @@ hunks / *** End Patch
 * Hunk lines start with " " (context), "-" (removed) or "+" (added).
 */
export function parsePatch(patch: string): PatchedFile[] {
  const files: PatchedFile[] = [];
  let current: (PatchedFile & { b: string[]; a: string[] }) | null = null;
  const flush = () => {
    if (current) files.push({ op: current.op, path: current.path, moveTo: current.moveTo, before: current.b.join("\n"), after: current.a.join("\n") });
    current = null;
  };
  for (const line of patch.split(/\r?\n/)) {
    const header = HEADER.exec(line);
    if (header) {
      flush();
      current = { op: header[1].toLowerCase() as PatchedFile["op"], path: header[2].trim(), before: "", after: "", b: [], a: [] };
      continue;
    }
    if (!current) continue;
    const move = MOVE.exec(line);
    if (move) current.moveTo = move[1].trim();
    else if (line.startsWith("***") || line.startsWith("@@")) continue;
    else if (line.startsWith("+")) current.a.push(line.slice(1));
    else if (line.startsWith("-")) current.b.push(line.slice(1));
    else if (line.startsWith(" ")) {
      current.b.push(line.slice(1));
      current.a.push(line.slice(1));
    }
  }
  flush();
  return files;
}
