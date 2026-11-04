import { useEffect, useState } from "react";
import type { SessionInfo } from "../../preload";
import { SetupWizard } from "./SetupWizard";
import { StartScreen } from "./StartScreen";
import { Workspace } from "./Workspace";

/** Start screen until a project is open, then its workspace. First launch shows the setup wizard. */
export function App() {
  const [info, setInfo] = useState<SessionInfo | null | undefined>(undefined);
  const [setupDone, setSetupDone] = useState<boolean | null>(null);
  const [showSetup, setShowSetup] = useState(false);

  useEffect(() => {
    window.agentTogether.info().then(setInfo);
    return window.agentTogether.onProject(setInfo);
  }, []);

  useEffect(() => {
    window.agentTogether.setupCompleted().then((done) => {
      setSetupDone(done);
      if (!done) setShowSetup(true);
    });
  }, []);

  if (info === undefined || setupDone === null) return <div className="start muted">启动中…</div>;
  if (showSetup) {
    return (
      <SetupWizard
        onClose={() => {
          setShowSetup(false);
          window.agentTogether.setupCompleted().then(setSetupDone);
        }}
      />
    );
  }
  if (!info) return <StartScreen onOpenSetup={() => setShowSetup(true)} />;
  return <Workspace key={info.root} info={info} onClose={() => window.agentTogether.closeProject().then(() => setInfo(null))} />;
}
