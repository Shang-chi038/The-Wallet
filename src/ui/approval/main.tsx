import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../styles/global.css";
import { ApprovalApp } from "./ApprovalApp";

const container = document.getElementById("root");
if (!container) throw new Error("Approval root element is missing.");

createRoot(container).render(
  <StrictMode>
    <ApprovalApp />
  </StrictMode>,
);
