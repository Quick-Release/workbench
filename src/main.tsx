import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";

import router from "./router";
import { overviewData } from "./data";
import "./styles.css";

for (const [name, value] of Object.entries(overviewData.meta.theme))
  document.documentElement.style.setProperty(`--${name}`, value);
document.title = `${overviewData.meta.projectName} · Workbench`;
document
  .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  ?.setAttribute("content", overviewData.meta.theme.bg);

const root = document.getElementById("app");

if (!root) throw new Error("Workbench mount point is missing.");

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
