import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Checkpoint {
  id: string;
  commit: string;
  at: string;
  label: string;
  nodeId: string | null;
}

const REF_PREFIX = "refs/loom/checkpoints/";
// Checkpoint commits are Loom's own bookkeeping, so they never need the user's git identity.
const IDENTITY = {
  GIT_AUTHOR_NAME: "Loom",
  GIT_AUTHOR_EMAIL: "loom@localhost",
  GIT_COMMITTER_NAME: "Loom",
  GIT_COMMITTER_EMAIL: "loom@localhost",
};

/**
 * Snapshots of a project's working tree kept as git commits under
 * refs/loom/checkpoints/*. They never touch the user's branch, index or stash.
 * Everything is scoped to the project directory, which may be a subfolder of a
 * larger repository; ignored files (node_modules, build output) are left alone.
 */
export class Checkpoints {
  constructor(readonly root: string) {}

  private git(args: string[], env: NodeJS.ProcessEnv = {}): string {
    return execFileSync("git", args, {
      cwd: this.root,
      encoding: "utf8",
      env: { ...process.env, ...IDENTITY, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }

  available(): boolean {
    try {
      return this.git(["rev-parse", "--is-inside-work-tree"]) === "true";
    } catch {
      return false;
    }
  }

  /** Tree of the project's current files (tracked and untracked, minus ignored), via a throwaway index. */
  private snapshotTree(): string {
    const index = path.join(os.tmpdir(), `loom-index-${process.pid}-${Date.now()}`);
    try {
      this.git(["add", "--all", "--", "."], { GIT_INDEX_FILE: index });
      return this.git(["write-tree"], { GIT_INDEX_FILE: index });
    } finally {
      fs.rmSync(index, { force: true });
    }
  }

  /** A commit of the project's current files that no ref points at yet; callers keep it alive with their own ref. */
  snapshot(message: string): string {
    return this.git(["commit-tree", this.snapshotTree(), "-m", message]);
  }

  create(label: string, nodeId: string | null = null): Checkpoint {
    const at = new Date().toISOString();
    const commit = this.snapshot(JSON.stringify({ label, nodeId, at }));
    const id = `${at.replace(/[-:.]/g, "").replace("T", "-").slice(0, 15)}-${commit.slice(0, 7)}`;
    this.git(["update-ref", REF_PREFIX + id, commit]);
    return { id, commit, at, label, nodeId };
  }

  /** Newest first. */
  list(): Checkpoint[] {
    const out = this.git(["for-each-ref", "--sort=-refname", "--format=%(refname)%00%(objectname)%00%(contents:subject)", REF_PREFIX]);
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [ref, commit, subject] = line.split("\0");
        const meta = JSON.parse(subject);
        return { id: ref.slice(REF_PREFIX.length), commit, at: meta.at, label: meta.label, nodeId: meta.nodeId };
      });
  }

  /**
   * Puts the project's files back as they were at a checkpoint. The current
   * state is saved as a checkpoint first, so a rollback can itself be undone.
   */
  rollback(id: string): Checkpoint {
    const target = this.list().find((c) => c.id === id);
    if (!target) throw new Error(`unknown checkpoint: ${id}`);
    const safety = this.create(`回滚前（回到 ${target.label}）`, target.nodeId);
    const top = this.git(["rev-parse", "--show-toplevel"]);
    // Files that appeared after the checkpoint: restore leaves untracked ones behind, so remove them.
    const added = this.git(["diff-tree", "-r", "--name-only", "--diff-filter=A", target.commit, safety.commit, "--", "."]);
    for (const rel of added.split("\n").filter(Boolean)) fs.rmSync(path.join(top, rel), { force: true });
    this.git(["restore", `--source=${target.commit}`, "--worktree", "--", "."]);
    return safety;
  }
}
