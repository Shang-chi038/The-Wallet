import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../styles/global.css";
import { OnboardingApp } from "./OnboardingApp";

const container = document.getElementById("root");
if (!container) throw new Error("Onboarding root element is missing.");

createRoot(container).render(
  <StrictMode>
    <OnboardingApp />
  </StrictMode>,
);
