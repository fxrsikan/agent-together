import { useEffect, useState } from "react";
import type { SessionInfo } from "../../preload";
import { StartScreen } from "./StartScreen";
import { Workspace } from "./Workspace";

/** Start screen until a project is open, then its workspace. */
export function App() {
  const [info, setInfo] = useState<SessionInfo | null | undefined>(undefined);

  useEffect(() => {
    window.agentTogether.info().then(setInfo);
    return window.agentTogether.onProject(setInfo);
  }, []);

  if (info === undefined) return <div className="start muted">启动中…</div>;
  if (!info) return <StartScreen />;
  return <Workspace key={info.root} info={info} onClose={() => window.agentTogether.closeProject().then(() => setInfo(null))} />;
}
