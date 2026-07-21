import "@fontsource/fraunces/400.css";
import "@fontsource/fraunces/600.css";
import "@fontsource/fraunces/700.css";
import "@fontsource/karla/400.css";
import "@fontsource/karla/600.css";
import "@fontsource/karla/700.css";

import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./styles/tokens.css";
import "./styles/base.css";
import { initTheme } from "./theme";

// Applied synchronously, before the first render, so there's no flash of
// the wrong theme on load (spec-5-visual-design.md §2.4).
initTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
