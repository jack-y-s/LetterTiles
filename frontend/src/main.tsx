import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// Register service worker for caching static assets (optional)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    try {
      navigator.serviceWorker.register('/service-worker.js').catch(() => {});
    } catch (e) {}
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
