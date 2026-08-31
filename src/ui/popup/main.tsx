import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../styles/global.css";
import { PopupApp } from "./PopupApp";

const container = document.getElementById("root");
if (!container) throw new Error("Popup root element is missing.");

createRoot(container).render(
  <StrictMode>
    <PopupApp />
  </StrictMode>,
);
