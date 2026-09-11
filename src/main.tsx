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
