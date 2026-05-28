import { createRoot } from "react-dom/client";
import { PanelApp } from "./PanelApp";
import "./panel.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Panel root element missing");
}

createRoot(root).render(<PanelApp />);
