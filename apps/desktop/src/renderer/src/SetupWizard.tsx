import { useCallback, useEffect, useState } from "react";
import type { SetupReport, SetupRequirement } from "@agent-together/core";

const LOGIN_LABEL: Record<SetupRequirement["login"], string> = {
  ok: "已登录",
  needed: "需要登录",
  unknown: "登录待确认",
};

function statusLine(r: SetupRequirement): string {
  if (!r.installed) return "未安装";
  const ver = r.version ? ` · ${r.version}` : "";
  if (r.id === "node" || r.id === "git") return r.ready ? `已就绪${ver}` : `需要升级${ver}`;
  return `${LOGIN_LABEL[r.login]}${ver}`;
}

/**
 * First-launch (and later, from the start screen) checklist: Node 22+, git,
 * and at least one AI assistant CLI. Detection runs in the main process.
 */
export function SetupWizard({ onClose }: { onClose: () => void }) {
  const [report, setReport] = useState<SetupReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      setReport(await window.agentTogether.setupCheck());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const copy = async (text: string) => {
    await window.agentTogether.setupCopy(text);
    setCopied(text);
    setTimeout(() => setCopied((c) => (c === text ? "" : c)), 1500);
  };

  const openLogin = async (id: string) => {
    try {
      await window.agentTogether.setupOpenTerminal(id);
      setNotice("已打开终端。按提示完成登录后，回到这里点「我装好了，再检查一次」。");
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err));
    }
  };

  const finish = async () => {
    await window.agentTogether.setupMarkDone();
    onClose();
  };

  const missing = report?.requirements.filter((r) => !r.ready) ?? [];
  const assistants = report?.requirements.filter((r) => r.id !== "node" && r.id !== "git") ?? [];
  const basics = report?.requirements.filter((r) => r.id === "node" || r.id === "git") ?? [];

  return (
    <div className="start setup-wizard">
      <h1>安装向导</h1>
      <p className="muted">
        用 Agent Together 之前，需要 Node.js 22+、git，以及至少一个已登录的 AI 编程助手。下面会帮你检查缺什么，并给出安装命令。
      </p>
      {error && <div className="finding finding-block">{error}</div>}
      {notice && <p className="muted">{notice}</p>}
      {!report && busy && <p className="muted">正在检查…</p>}
      {report && (
        <>
          <section className="setup-section">
            <h3>基础环境</h3>
            <ul className="setup-list">
              {basics.map((r) => (
                <RequirementRow key={r.id} r={r} copied={copied} onCopy={copy} onLogin={openLogin} />
              ))}
            </ul>
          </section>
          <section className="setup-section">
            <h3>AI 编程助手（至少一个即可）</h3>
            <ul className="setup-list">
              {assistants.map((r) => (
                <RequirementRow key={r.id} r={r} copied={copied} onCopy={copy} onLogin={openLogin} />
              ))}
            </ul>
          </section>
          <div className="actions setup-actions">
            <button onClick={refresh} disabled={busy}>
              {busy ? "检查中…" : "我装好了，再检查一次"}
            </button>
            {report.ready ? (
              <button className="primary" onClick={finish}>
                都好了，开始使用
              </button>
            ) : (
              <span className="muted small">
                还差：{missing.map((r) => r.name).join("、") || "继续检查"}。装好后点左边的按钮再查一次。
              </span>
            )}
            <button className="link" onClick={onClose} title="下次打开应用还会再提醒">
              先去启动页
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function RequirementRow({
  r,
  copied,
  onCopy,
  onLogin,
}: {
  r: SetupRequirement;
  copied: string;
  onCopy: (text: string) => void;
  onLogin: (id: string) => void;
}) {
  return (
    <li className={`setup-item${r.ready ? " setup-ok" : ""}`}>
      <div className="row">
        <strong>{r.name}</strong>
        <span className={r.ready ? "badge badge-good" : "badge badge-bad"}>{statusLine(r)}</span>
      </div>
      <p className="muted small">{r.explain}</p>
      {r.loginNote && <p className="muted small">{r.loginNote}</p>}
      {r.installCommand && r.id === "grok-build" && <p className="muted small">{r.installCommand}</p>}
      {r.installCommand && r.id !== "grok-build" && (
        <div className="setup-cmd">
          <code className="path">{r.installCommand}</code>
          <button onClick={() => onCopy(r.installCommand)}>{copied === r.installCommand ? "已复制" : "复制"}</button>
        </div>
      )}
      {r.loginCommand && (
        <div className="actions">
          <span className="muted small">登录：在终端运行 <code>{r.loginCommand}</code>，按提示完成</span>
          <button onClick={() => onLogin(r.id)}>打开终端登录</button>
          <button onClick={() => onCopy(r.loginCommand!)}>{copied === r.loginCommand ? "已复制" : "复制命令"}</button>
        </div>
      )}
    </li>
  );
}
