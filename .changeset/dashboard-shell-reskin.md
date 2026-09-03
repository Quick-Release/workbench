---
"@quick-release/workbench": minor
---

Re-skin the app shell to a shadcn dashboard layout: a persistent collapsible sidebar (icon rail on desktop, sheet on mobile) with Overview/Sessions navigation and active-state highlighting, a sticky translucent header carrying the project name, snapshot line, read-only badge, and repository link, and a clean full-height content frame. Per-page duplicated headers, ambient blobs, and the old centered column are gone. Config-driven themes keep driving every color via new sidebar tokens derived from the legacy variable names.
