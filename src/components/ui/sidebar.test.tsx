import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Sidebar, SidebarProvider } from "./sidebar";

const renderSidebar = (defaultOpen?: boolean) =>
  renderToString(
    <SidebarProvider defaultOpen={defaultOpen}>
      <Sidebar collapsible="icon">
        <div />
      </Sidebar>
    </SidebarProvider>,
  );

describe("SidebarProvider", () => {
  it("restores the saved desktop state from its cookie", () => {
    const originalDocument = globalThis.document;
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { cookie: "other=value; sidebar_state=false" },
    });

    try {
      expect(renderSidebar()).toContain('data-state="collapsed"');
    } finally {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: originalDocument,
      });
    }
  });

  it("uses the provided default when no saved state exists", () => {
    const originalDocument = globalThis.document;
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { cookie: "" },
    });

    try {
      expect(renderSidebar(false)).toContain('data-state="collapsed"');
    } finally {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: originalDocument,
      });
    }
  });
});
