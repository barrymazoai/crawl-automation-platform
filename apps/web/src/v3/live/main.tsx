import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LiveApp } from "./App";
import { Dashboard } from "./Dashboard";
import "../theme.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {new URL(location.href).searchParams.get("view") === "dashboard" ? <Dashboard/> : new URL(location.href).searchParams.get("view") === "reviews" ? <Dashboard reviewsOnly/> : <LiveApp />}
  </StrictMode>,
);
