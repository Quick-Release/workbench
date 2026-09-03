# Dashboard shell design decisions

Status: accepted

## Context

Re-skinning the workbench app shell to the shadcn-ui-kit-dashboard layout (issue #7) forced three decisions the prior research note (`docs/research/app-shell-shadcn-dashboard.md`) flagged as open, one of which overturns a choice recorded in `docs/research/shadcn-adoption.md` §7 ("`--radius: 0rem` — the design is deliberately sharp").

## Decisions

1. **Adopt the reference corner radius (`--radius: 0.625rem`).** The goal is visual similarity to the reference dashboard, whose look is rounded; a "sharp dashboard" hybrid would preserve a token whose original rationale (a distinct brand identity) is superseded by this re-skin.
2. **Dark-only for phase 1.** Workbench ships only dark values; the reference assumes a light default with a `.dark` overlay. Authoring a light palette is deferred; a small class-toggle hook is the designated phase-2 follow-up. next-themes is not adopted.
3. **Test seam: the existing SSR render seam.** Shell coverage extends the `renderToString` smoke tests (shell landmarks, nav active state via a minimal in-test router) rather than introducing router-integration harnesses or new tooling.

## Consequences

- Every radius-derived utility (cards, inputs, badges, sidebar inset) renders rounded; reverting is a one-variable change in `styles.css`.
- The `@custom-variant dark` half of the token file remains unfilled until the light palette is authored.
- Vendored shadcn primitives stay token-driven, so the phase-2 light palette needs no component changes.
