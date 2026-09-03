---
"@quick-release/workbench": patch
---

Adopt a dark neutral-charcoal default theme: `#14151b` background (sidebar shares it), `#191a24` panels, white `#ffffff` text, rust `#c44900` accent, plum-anchored info triad. Sidebar nav links read as plain text on the sidebar background (active item marked by weight, not a fill); orange stays for highlights. Also fixes the vendored sidebar menu buttons matching their `data-active` styles regardless of state (presence-based selector vs React's `data-active="false"`). Host configs overriding `theme` keep working unchanged.
