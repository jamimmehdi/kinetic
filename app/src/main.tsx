import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { installDevMock } from "./devMock";
import "./styles.css";

// In a plain browser during development there is no Electron bridge; fake one.
if (import.meta.env.DEV) installDevMock();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
