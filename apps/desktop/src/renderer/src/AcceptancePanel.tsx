import { useEffect, useState } from "react";
import type { AcceptanceInfo, AcceptanceRecord, BeatResult, RestorePreview, ScenarioResult } from "../../preload";
import { errorText } from "./errors";

/**
 * 验收与交付 (phase one, M4): accept the version against its scenarios — the
 * evidence layers, each scenario run on a copy of the product with real input and
 * screenshots — then walk through each scenario by hand and say whether it
 * matches. What fails goes back to the assistant; when everything holds, save the
 * version as stable (code checkpoint, data backup, start package) and go back to
 * it later.
 */

const AGENT_NAMES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor", "grok-build": "Grok Build" };
const LAYER_MARK: Record<string, { mark: string; tone: string }> = {
  pending: { mark: "○", tone: "muted" },
  running: { mark: "…", tone: "warn" },
  passed: { mark: "✓", tone: "good" },
  skipped: { mark: "–", tone: "muted" },
  failed: { mark: "✗", tone: "bad" },
};
const BEAT: Record<string, { mark: string; tone: string }> = {
  ...LAYER_MARK,
  manual: { mark: "✋", tone: "muted" },
};
const SOURCE: Record<string, string> = { pre: "准备", step: "步骤", expected: "期望", data: "数据", error: "出错时" };
const STATUS: Record<AcceptanceRecord["status"], { label: string; tone: string }> = {
  running: { label: "正在验收", tone: "badge-warn" },
  passed: { label: "自动验收通过", tone: "badge-good" },
  failed: { label: "没有通过", tone: "badge-bad" },
  stopped: { label: "没有做完", tone: "" },
  error: { label: "出错了", tone: "badge-bad" },
};
const time = (iso: string) => new Date(iso).toLocaleString();

function Shot({ path }: { path: string }) {
  const [src, setSrc] = useState<string | null>(null);
  return src ? (
    <img className="accept-shot" src={src} alt="这一步之后的页面" onClick={() => setSrc(null)} title="点一下收起" />
  ) : (
    <button className="link small" onClick={() => window.agentTogether.acceptanceShot(path).then(setSrc)}>
      看截图
    </button>
  );
}

function Beats({ beats }: { beats: BeatResult[] }) {
  return (
    <ol className="beats">
      {beats.map((b) => (
        <li key={b.id} className={`beat beat-${b.status}`}>
          <span className={`mark ${BEAT[b.status]?.tone ?? ""}`}>{BEAT[b.status]?.mark}</span>
          <span className="muted small">{SOURCE[b.source]}</span> {b.say}
          {b.status === "manual" && <div className="small muted">要你亲手检查：{b.manual}</div>}
          {b.error && <div className="small bad">{b.error}</div>}
          {b.judged && <div className="small muted">（这一条由助手看页面判断：{b.judged}）</div>}
          {b.problems && b.problems.length > 0 && <div className="small muted">页面报错：{b.problems.slice(0, 3).join("；")}</div>}
          {b.shot && <Shot path={b.shot} />}
        </li>
      ))}
    </ol>
  );
}

function ScenarioRun({ s, open }: { s: ScenarioResult; open: boolean }) {
  const passed = s.beats.filter((b) => b.status === "passed").length;
  const manual = s.beats.filter((b) => b.status === "manual").length;
  return (
    <details className="accept-scenario" open={open}>
      <summary>
        <span className={`mark ${LAYER_MARK[s.status === "error" ? "failed" : s.status]?.tone ?? ""}`}>{LAYER_MARK[s.status === "error" ? "failed" : s.status]?.mark ?? "○"}</span> {s.id} {s.name}
        <span className="muted small">
          {" "}
          · {passed} 项通过{manual ? ` · ${manual} 项要亲手检查` : ""}
          {s.replans ? ` · 脚本按页面改写过 ${s.replans} 次` : ""}
        </span>
      </summary>
      {s.error && <p className="small bad">{s.error}</p>}
      <Beats beats={s.beats} />
    </details>
  );
}

export function AcceptancePanel({ version, onChange, onOpenPreview }: { version: number; onChange: (notice: string) => void; onOpenPreview: () => void }) {
  const [info, setInfo] = useState<AcceptanceInfo | null>(null);
  const [busy, setBusy] = useState("");
  const [agent, setAgent] = useState("claude-code");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [saying, setSaying] = useState<string | null>(null);
  const [dataText, setDataText] = useState<string | null>(null);
  const [mockOk, setMockOk] = useState(false);
  const [restore, setRestore] = useState<RestorePreview | null>(null);

  const refresh = () => window.agentTogether.acceptanceInfo().then(setInfo);
  useEffect(() => {
    void refresh();
  }, [version]);
  useEffect(
    () =>
      window.agentTogether.onAcceptanceState((record) => {
        setInfo((i) => (i ? { ...i, record, running: record.status === "running" } : i));
        void refresh();
      }),
    [],
  );

  if (!info || info.version === null) return null;
  const act = (label: string, work: () => Promise<unknown>, notice?: string) => async () => {
    setBusy(label);
    try {
      const next = await work();
      if (next && typeof next === "object" && "missing" in next) setInfo(next as AcceptanceInfo);
      if (notice) onChange(notice);
    } catch (err) {
      onChange(errorText(err));
    } finally {
      setBusy("");
      void refresh();
    }
  };
  const r = info.record;
  const status = r ? STATUS[r.status] : null;
  const ready = !!r && r.version === info.version;
  const fixCount = info.fixes.length;

  return (
    <section className="acceptance">
      <div className="row">
        <h4>验收与交付</h4>
        {status && ready && <span className={`badge ${status.tone}`}>{status.label}</span>}
      </div>

      {info.cardsLeft > 0 && !r && <p className="muted small">第 {info.version} 版还有 {info.cardsLeft} 张卡片没做完；做完再按使用场景验收。</p>}
      {!info.hasRunConfig && <p className="muted small">先在「产品预览」里让产品能启动，才能验收。</p>}

      {info.hasRunConfig && (
        <div className="small accept-data">
          <span className="muted">业务数据存在：</span>
          {dataText === null ? (
            <>
              {info.data?.length ? info.data.join("、") : info.data ? "（没有数据文件）" : "第一次验收时自动找出来"}{" "}
              <button className="link small" onClick={() => setDataText((info.data ?? []).join(", "))} disabled={info.running}>
                修改
              </button>
            </>
          ) : (
            <span className="row">
              <input value={dataText} onChange={(e) => setDataText(e.target.value)} placeholder="例如 data/, manuscript/, storyboard.json" aria-label="业务数据的位置" />
              <button
                className="small"
                onClick={act("data", async () => {
                  const next = await window.agentTogether.acceptanceSetData(dataText.split(/[,，、\s]+/));
                  setDataText(null);
                  return next;
                })}
              >
                保存
              </button>
            </span>
          )}
          <div className="muted">验收在一份不带这些数据的副本上做，不会动你的数据；保存稳定版本时会把它们备份下来。</div>
        </div>
      )}

      {info.hasRunConfig && (
        <div className="actions">
          {info.running ? (
            <button disabled={!!busy} onClick={act("stop", () => window.agentTogether.acceptanceStop(), "做完当前这一步就结束验收")}>
              结束验收
            </button>
          ) : (
            <button
              className={!r || r.status !== "passed" ? "primary" : ""}
              disabled={!!busy}
              onClick={act("start", () => window.agentTogether.acceptanceStart(), "开始验收：先跑测试，再在一个看不见的浏览器里按场景一步步操作产品")}
              title={info.hasLlm ? undefined : "第一次验收要帮手模型来写验收脚本"}
            >
              {r ? "重新验收" : "开始验收"}
            </button>
          )}
        </div>
      )}

      {r && (
        <>
          <p className="muted small">
            {r.note}
            {r.endedAt ? `（${time(r.endedAt)}）` : ""}
          </p>
          <table className="layers">
            <tbody>
              {r.layers.map((l) => (
                <tr key={l.id}>
                  <td className={`mark ${LAYER_MARK[l.status].tone}`}>{LAYER_MARK[l.status].mark}</td>
                  <td className="layer-name">{l.name}</td>
                  <td className="small">{l.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {r.scenarios.map((s) => (
            <ScenarioRun key={s.id} s={s} open={s.status === "running" || s.status === "failed"} />
          ))}
        </>
      )}

      {r && !info.running && fixCount > 0 && (
        <div className="decision">
          <strong>有 {fixCount} 处要改</strong>
          <ul className="small">
            {info.fixes.map((f, i) => (
              <li key={i}>
                {f.scenarioId ?? "检查"}：{f.task.split("\n")[0]}
                {f.card ? <span className="muted">（交给「{f.card}」）</span> : <span className="bad">（对不上卡片）</span>}
              </li>
            ))}
          </ul>
          <div className="row">
            <select value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="用哪个助手">
              {info.agents.map((a) => (
                <option key={a} value={a}>
                  {AGENT_NAMES[a] ?? a}
                </option>
              ))}
            </select>
            <button className="primary" disabled={!!busy} onClick={act("fix", () => window.agentTogether.acceptanceFix(agent), "交给助手修改：带着截图和错误；改完会自动重新验收")}>
              交给助手修改
            </button>
          </div>
        </div>
      )}

      {r && !info.running && (
        <div className="walk">
          <h5>亲手走一遍</h5>
          <p className="muted small">
            {r.status === "passed" ? "自动验收通过了。" : "自动验收还没通过，也可以先亲手试。"}在「产品预览」里按每个场景操作一遍，选「符合」或「不符合」。打✋的几项自动化做不到，请特别看一下。
          </p>
          <button className="small" onClick={onOpenPreview}>
            打开产品预览
          </button>
          {info.scenarios.map((s) => {
            const u = r.user[s.id];
            const auto = r.scenarios.find((x) => x.id === s.id);
            const manual = auto?.beats.filter((b) => b.status === "manual") ?? [];
            return (
              <details key={s.id} className="walk-scenario">
                <summary>
                  {u ? (u.ok ? <span className="mark good">✓</span> : <span className="mark bad">✗</span>) : <span className="mark muted">○</span>} {s.id} {s.name}
                </summary>
                {s.input && (
                  <div className="small">
                    <span className="muted">用这段输入：</span>
                    <pre className="pre">{s.input}</pre>
                  </div>
                )}
                <ol className="small">
                  {s.steps.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ol>
                <div className="small muted">应该看到：</div>
                <ul className="small">
                  {[...s.expected, ...s.dataChecks].map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
                {manual.length > 0 && (
                  <ul className="small">
                    {manual.map((b) => (
                      <li key={b.id}>
                        ✋ {b.ref}
                        <span className="muted">（{b.manual}）</span>
                      </li>
                    ))}
                  </ul>
                )}
                {u && !u.ok && <p className="small bad">你说不符合：{u.note}</p>}
                {saying === s.id ? (
                  <div>
                    <textarea
                      rows={3}
                      value={notes[s.id] ?? ""}
                      onChange={(e) => setNotes({ ...notes, [s.id]: e.target.value })}
                      placeholder="哪一步、看到了什么、应该是什么"
                      aria-label={`${s.id} 哪里不符合`}
                    />
                    <div className="actions">
                      <button
                        className="primary"
                        disabled={!!busy || !notes[s.id]?.trim()}
                        onClick={act("no", async () => {
                          const next = await window.agentTogether.acceptanceConfirm(s.id, false, notes[s.id]);
                          setSaying(null);
                          return next;
                        }, "记下了，可以交给助手修改")}
                      >
                        记下来
                      </button>
                      <button onClick={() => setSaying(null)}>取消</button>
                    </div>
                  </div>
                ) : (
                  <div className="actions">
                    <button className={u?.ok ? "" : "primary"} disabled={!!busy} onClick={act("ok", () => window.agentTogether.acceptanceConfirm(s.id, true), `${s.id} 符合`)}>
                      符合
                    </button>
                    <button disabled={!!busy} onClick={() => setSaying(s.id)}>
                      不符合…
                    </button>
                  </div>
                )}
              </details>
            );
          })}
        </div>
      )}

      {r && !info.running && (
        <div className="stable">
          <h5>稳定版本</h5>
          {info.missing.length ? (
            <ul className="small muted">
              {info.missing.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          ) : (
            <>
              <p className="small">都通过了。保存后会记下这一版的代码检查点、验收记录和截图，备份业务数据，并留下可以交给别人的启动包。</p>
              {info.mockServices.length > 0 && (
                <label className="small check">
                  <input type="checkbox" checked={mockOk} onChange={(e) => setMockOk(e.target.checked)} />
                  我知道 {info.mockServices.join("、")} 用的还是示例服务（结果按固定规则算），先这样交付。这会写进版本记录。
                </label>
              )}
              <button
                className="primary"
                disabled={!!busy || (info.mockServices.length > 0 && !mockOk)}
                onClick={act("save", () => window.agentTogether.versionSave(mockOk), `第 ${info.version} 版保存为稳定版本`)}
              >
                保存为第 {info.version} 版稳定版本
              </button>
            </>
          )}
        </div>
      )}

      {info.versions.length > 0 && (
        <div className="versions">
          <h5>已保存的版本</h5>
          <ul className="small">
            {info.versions.map((v) => (
              <li key={v.version}>
                <strong>第 {v.version} 版</strong> <span className="muted">{time(v.savedAt)}</span> · {v.scenarios.length} 个场景
                {v.mockAccepted ? " · 示例服务" : ""} · 数据备份 {v.data.files} 个文件
                {v.knownLimits.length > 0 && <div className="muted">已知限制：{v.knownLimits.slice(0, 3).join("；")}</div>}
                <div className="actions">
                  {v.package && (
                    <button className="small" onClick={act("pkg", () => window.agentTogether.versionShowPackage(v.version))}>
                      打开启动包所在文件夹
                    </button>
                  )}
                  <button className="small" disabled={!!busy || info.running} onClick={act("preview", async () => setRestore(await window.agentTogether.versionRestorePreview(v.version)))}>
                    回到这个版本
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {restore && (
        <div className="decision">
          <strong>回到第 {restore.version} 版</strong>
          <p className="small">代码、画布和需求会回到保存这个版本时的样子；现在的状态先存成检查点，回去之后还能再回来。</p>
          <p className="small">{restore.note}</p>
          <div className="actions">
            {restore.sameData ? (
              <button className="primary" disabled={!!busy} onClick={act("restore", async () => restoreTo(restore.version, "current"))}>
                回去
              </button>
            ) : (
              <>
                <button className="primary" disabled={!!busy} onClick={act("restore", async () => restoreTo(restore.version, "backup"))}>
                  用第 {restore.version} 版的数据备份
                </button>
                <button disabled={!!busy} onClick={act("restore", async () => restoreTo(restore.version, "current"))}>
                  保留现在的数据
                </button>
              </>
            )}
            <button onClick={() => setRestore(null)}>取消</button>
          </div>
        </div>
      )}
    </section>
  );

  async function restoreTo(v: number, data: "backup" | "current") {
    const res = await window.agentTogether.versionRestore(v, data);
    setRestore(null);
    setInfo(res.info);
    onChange(res.ok ? `回到了第 ${v} 版，试启动成功` : `回到了第 ${v} 版，但启动失败：${res.error ?? ""}`);
  }
}
