import { useEffect, useState } from "react";
import type { ImportProposal, ImportStatus } from "../../preload";
import { errorText } from "./errors";
import { ProposalView } from "./ProposalView";

/**
 * Shown after opening existing code: the canvas was drawn from the folders, so the
 * cards have names and files but no goals. Three steps, each optional and each
 * asking first: turn on git, let the helper model describe the cards, set the
 * test command. Hidden once the user says it is done.
 */
export function ImportChecklist({ version, onChange }: { version: number; onChange: (notice: string) => void }) {
  const [status, setStatus] = useState<ImportStatus | null>(null);
  const [proposal, setProposal] = useState<ImportProposal | null>(null);
  const [busy, setBusy] = useState("");

  useEffect(() => {
    window.agentTogether.importStatus().then(setStatus);
  }, [version]);
  if (!status || !status.imported || status.reviewed) return null;

  const act = async (label: string, work: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await work();
    } catch (err) {
      onChange(errorText(err));
    } finally {
      setBusy("");
    }
  };
  const suggestedTest = proposal?.testCommand || status.guessedTest;

  return (
    <section className="editor import-checklist">
      <h4>导入已有项目：还差几步</h4>
      <p className="muted">画布是按文件夹自动分出来的。下面几步都可以跳过，做了会更好用。</p>

      <p>
        <strong>1. git</strong>{" "}
        {status.hasGit ? (
          <span className="muted">已经在用，检查点、回滚、赛马和进化都能用。</span>
        ) : (
          <>
            <span className="muted">这个文件夹还没用 git，检查点、回滚、赛马和进化都要靠它。只建仓库，不会提交任何东西。</span>
            <span className="actions">
              <button
                disabled={!!busy}
                onClick={() =>
                  act("git", async () => {
                    await window.agentTogether.initGit();
                    onChange("已初始化 git，检查点、回滚、赛马和进化已打开");
                  })
                }
              >
                {busy === "git" ? "初始化中…" : "帮我初始化 git"}
              </button>
            </span>
          </>
        )}
      </p>

      <p>
        <strong>2. 卡片说明</strong>{" "}
        <span className="muted">
          {status.emptyCards
            ? `${status.cards} 张卡片里有 ${status.emptyCards} 张还没写目标。可以让帮手模型读一遍代码，写好名字、目标和验收标准，每条都附上代码出处，你看过再采用。`
            : "每张卡片都写了目标。"}
        </span>
      </p>
      {status.emptyCards > 0 && !proposal && (
        <div className="actions">
          <button
            className="primary"
            disabled={!!busy || !status.helper}
            title={status.helper ? `用 ${status.helper} 读代码` : "先在下面「帮手模型」里选一个"}
            onClick={() =>
              act("read", async () => {
                const p = await window.agentTogether.understandProject();
                setProposal(p);
              })
            }
          >
            {busy === "read" ? "正在读代码…（约一两分钟）" : "让 AI 读代码补上"}
          </button>
          {!status.helper && <span className="muted">还没有帮手模型，先在下面「帮手模型」里选一个。</span>}
        </div>
      )}
      {proposal && (
        <ProposalView
          proposal={proposal}
          busy={!!busy}
          onCancel={() => setProposal(null)}
          onApply={(kept, chosen) =>
            act("apply", async () => {
              await window.agentTogether.applyImportProposal(kept, chosen);
              setProposal(null);
              onChange(`已更新 ${chosen.length} 张卡片的说明，出处已存下；已有的项目描述、技术栈和测试命令没有覆盖`);
            })
          }
        />
      )}

      <p>
        <strong>3. 测试命令</strong>{" "}
        {status.testCommand ? (
          <span className="muted">
            已设置：<code>{status.testCommand}</code>，每次 AI 做完都会跑。
          </span>
        ) : suggestedTest ? (
          <>
            <span className="muted">
              还没有。从文件看可能是 <code>{suggestedTest}</code>。
            </span>
            <span className="actions">
              <button
                disabled={!!busy}
                onClick={() =>
                  act("test", async () => {
                    await window.agentTogether.saveProjectInfo({ testCommand: suggestedTest });
                    onChange(`测试命令设为 ${suggestedTest}，可以在「项目设置」里改`);
                  })
                }
              >
                用这个
              </button>
            </span>
          </>
        ) : (
          <span className="muted">看不出这个项目怎么跑测试。有的话请在「项目设置」里填；没有测试，AI 做完就没法自动检查。</span>
        )}
      </p>

      <div className="actions">
        <button
          onClick={() =>
            act("done", async () => {
              await window.agentTogether.reviewImport();
              onChange("导入清单已收起");
            })
          }
        >
          都看过了，收起
        </button>
      </div>
    </section>
  );
}
