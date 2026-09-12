// Fonts are bundled, not fetched — Enisma has to look right with no network.
// Google Sans Flex has no Ethiopic coverage, so Noto Sans Ethiopic carries Ge'ez.
import "@fontsource-variable/google-sans-flex/opsz.css";
import "@fontsource-variable/noto-sans-ethiopic/wght.css";

// Side-effect import: initialises i18next before any component renders.
import "@/lib/i18n";

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// No right-click menu anywhere for now; nothing in the app uses one yet.
// Remove this listener to bring the webview's default menu back.
document.addEventListener("contextmenu", (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
