import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { DemoProvider } from "./store";
import "./theme.css";

// Intentionally no imports from V2 main.tsx, api.ts, or production clients.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DemoProvider>
      <App />
    </DemoProvider>
  </StrictMode>,
);
