# Persisting the sidebar collapse preference

**Date:** 2026-09-04

**Sources:** primary only — this repository's source/history, React documentation, MDN Web Platform documentation, and the official shadcn/ui Sidebar documentation.

## Question

When a developer collapses the desktop sidebar to its icon rail, or expands it again, how should that choice survive route changes and a page refresh?

## Finding

The sidebar already writes a persistent cookie when its desktop state changes:

- `src/components/ui/sidebar.tsx:23-24` defines the `sidebar_state` cookie and a seven-day lifetime.
- `src/components/ui/sidebar.tsx:84-95` writes `sidebar_state=true` or `sidebar_state=false` with `path=/`, so the value is available across the app's routes and survives a normal refresh during that lifetime.
- Before this change, `SidebarProvider` initialized internal state only from `defaultOpen` (`HEAD:src/components/ui/sidebar.tsx:67-81`); it never read the cookie. Since `AppShell` mounts the provider at the shared shell (`src/components/layout/app-shell.tsx:15-24`), route navigation did not need new state, but a fresh mount always returned to the default expanded state.

The official shadcn/ui documentation defines `SidebarProvider` as the state/context owner, exposes `defaultOpen`, and defines `collapsible="icon"` as the icon-collapsed mode: [Sidebar component](https://ui.shadcn.com/docs/components/sidebar).

## Recommended implementation

Read the existing cookie in a lazy `useState` initializer, with `defaultOpen` as the fallback. The implementation now does this at `src/components/ui/sidebar.tsx:67-82`:

1. Return `defaultOpen` when `document` is unavailable, keeping server rendering and Node tests safe.
2. Parse the semicolon-separated `document.cookie` string for the exact `sidebar_state=` name.
3. Accept only `true` and `false`; use `defaultOpen` for a missing or malformed value.
4. Keep the existing write in `setOpen`, so the click updates both React state and the cookie.

This matches the Web Platform contract: [`Document.cookie`](https://developer.mozilla.org/en-US/docs/Web/API/Document/cookie) exposes a semicolon-separated cookie list and accepts a name/value plus attributes when writing; `path` and `max-age` are valid cookie attributes. The existing `path=/` and seven-day `max-age` are sufficient for this preference.

A browser storage migration is unnecessary. [`localStorage`](https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage) is also origin-scoped and survives browser sessions, but the component already has a cookie persistence contract. Cookies are a reasonable minimal change here; MDN notes that Web Storage is preferable for larger client-only data because cookies are sent with requests ([Using HTTP cookies](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Cookies)).

## Edge cases

- **Current rendering model:** `src/main.tsx:20-24` uses `createRoot`, not `hydrateRoot`, so the browser can read the cookie during the initial state initialization without a current SSR hydration mismatch.
- **Future SSR:** If this app begins using `hydrateRoot`, the server and client must produce identical initial markup. React documents hydration mismatches as bugs and specifically calls out browser-only APIs as a cause ([`hydrateRoot` caveats](https://react.dev/reference/react-dom/client/hydrateRoot#caveats)). In that architecture, read the cookie on the server and pass the resulting value as `defaultOpen`, or deliberately use React's documented client-only two-pass pattern ([`useEffect` server/client rendering](https://react.dev/reference/react/useEffect#displaying-different-content-on-the-server-and-the-client)).
- **Initializer purity:** React calls a function passed to `useState` during initialization and ignores it on later renders; in development Strict Mode it may call it twice ([`useState`](https://react.dev/reference/react/useState#usestate)). The initializer is read-only, so repeated reads do not change the cookie or state.
- **Mobile behavior:** `toggleSidebar` uses `openMobile` on mobile and `setOpen` on desktop (`src/components/ui/sidebar.tsx:99-102`). The persisted preference therefore represents the desktop expanded/icon state; mobile drawer visibility remains per-session interaction state. This matches the request's collapse-to-icons behavior.
- **Lifetime:** The preference currently lasts seven days, not indefinitely. If product requirements later require indefinite retention, increase the cookie lifetime or move the preference to `localStorage`; that would be a deliberate storage-policy change.

## Test implications

`src/components/ui/sidebar.test.tsx:15-48` verifies that a saved `sidebar_state=false` restores the collapsed state and that the supplied default remains the fallback when no cookie exists. The test uses server rendering with a minimal document stub, avoiding a new DOM test dependency.

A browser-level test should additionally click `SidebarTrigger`, assert that the cookie changes to the selected boolean, navigate to another route, and reload with the cookie retained. The current implementation keeps the existing write path at `src/components/ui/sidebar.tsx:84-95`, so no separate route-level persistence mechanism is needed.

## Verification

- `pnpm exec vp test run src/components/ui/sidebar.test.tsx` — passed (2 tests).
- `pnpm exec tsc --noEmit` — passed.
- Targeted `vp lint` and formatting checks — passed.
- `pnpm build` — passed.
- Full `vp test run` still has an unrelated existing failure in `src/data.test.ts` because generated session data has `enabled: false` while the test expects `true`.
- `pnpm check` still reports pre-existing formatting issues in agent/skill files; the changed sidebar files pass targeted formatting.

## Sources

- Local current implementation: `src/components/ui/sidebar.tsx:23-24,67-102`
- Local shell ownership: `src/components/layout/app-shell.tsx:15-24`
- Local client entrypoint: `src/main.tsx:20-24`
- Local mobile detection: `src/hooks/use-mobile.ts:5-18`
- Local pre-change implementation: `HEAD:src/components/ui/sidebar.tsx:67-81`
- [React `useState`](https://react.dev/reference/react/useState)
- [React `useEffect`, displaying different content on server and client](https://react.dev/reference/react/useEffect#displaying-different-content-on-the-server-and-the-client)
- [React `hydrateRoot` caveats](https://react.dev/reference/react-dom/client/hydrateRoot#caveats)
- [MDN `Document.cookie`](https://developer.mozilla.org/en-US/docs/Web/API/Document/cookie)
- [MDN Using HTTP cookies](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Cookies)
- [MDN `Window.localStorage`](https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage)
- [shadcn/ui Sidebar](https://ui.shadcn.com/docs/components/sidebar)
