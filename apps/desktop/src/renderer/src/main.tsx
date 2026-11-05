import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import { App } from "./App";
import { applyTheme } from "./theme";

applyTheme(); // before the first paint, so a dark choice never flashes light

createRoot(document.getElementById("root")!).render(<App />);
