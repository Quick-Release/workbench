# Triggering local CLI commands (CodeRabbit / zcode review) from the web UI

**Date:** 2026-09-04
**Sources:** primary only — fetched live on this date: Chrome native-messaging and messaging docs (developer.chrome.com), the Chrome `externally_connectable` behavior described therein, VS Code command-line docs (code.visualstudio.com), Claude Code headless docs (code.claude.com/docs/en/headless, via its redirect chain), CodeRabbit CLI docs (docs.coderabbit.ai/cli and /cli/headless-cli-integration — note: docs.coderabbit.io URLs 404; the live docs domain is **docs.coderabbit.ai**), GitHub Codespaces docs (docs.github.com), GitHub REST workflow-dispatch reference (docs.github.com), the ttyd README (github.com/tsl0922/ttyd), the GitHub Engineering post on localhost CORS/DNS-rebinding (github.blog), Apple's custom-URL-scheme page (developer.apple.com — page is JS-walled, details below marked accordingly), and — as primary local sources — the zcode CLI itself (`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs --help`, executed on this machine, v0.16.5) and this repo (`AGENTS.md`, `package.json`, `docs/research/alchemy-adoption.md` for the stack description). No blog write-ups were relied on for mechanics.

## Question

On an open GitHub PR page in our web UI, the user clicks a button and a CLI runs **on their Mac terminal**: either (a) the CodeRabbit CLI to review the PR, or (b) a `zcode` one-shot (headless) GLM prompt that reviews the PR and posts GitHub comments. What are the viable browser-to-local-machine bridges, and which fits this repo (Cloudflare Worker backend, Effect, Vite/TanStack frontend)?

## TL;DR

**Recommended: a small local helper daemon listening on `127.0.0.1` (HTTP + SSE/WebSocket), triggered by the web UI, plus a GitHub Actions `workflow_dispatch` fallback when the helper isn't running.** The local daemon is the only option that needs no Mac app bundle, no browser extension, no App Store/notarization story, streams output back to the UI naturally, and is exactly the pattern dev tools (Vite, ttyd, Electron debuggers) already normalize for users. Deep links (`myapp://`) work but give you launch-with-no-feedback and require shipping a `.app` (LaunchServices registration; notarization if distributed outside `brew`); browser native messaging works but only via an installed extension and a per-browser host manifest, and a **webpage cannot call `connectNative` directly** — it must relay through the extension. ttyd/xterm.js is the fast path to _visible_ terminal output in the browser if we want the user to literally watch the review run. As a server-side fallback, `POST /repos/{owner}/{repo}/actions/workflows/{id}/dispatches` runs the same two CLIs in CI with zero local setup.

**Concrete invocations (verified):**

- CodeRabbit: `cr auth login --api-key "$CODERABBIT_API_KEY"` once, then `coderabbit review --agent --base main` from inside a checkout of the PR branch (the CLI reviews the **local worktree vs a base** — there is no documented review-by-PR-URL command).
- zcode headless: `zcode --prompt "<instructions>" --mode yolo` (mode defaults to `yolo` for `--prompt`), with `--cwd`, `--allowed-tools`, `--resume <sessionId>`, `--json`. **Caveat found by local smoke test:** running the bundled `zcode.cjs` outside the ZCode desktop app fails with `Error: Model config is missing. Create ~/.zcode/cli/config.json with an explicit model provider` — headless use needs a `zcode login` (Z.AI OAuth) or explicit provider config; the desktop app's env vars don't carry over.

---

## 1. Custom URL scheme / deep link

Mechanism: a `.app` bundle declares schemes in `Info.plist` under `CFBundleURLTypes` (`CFBundleURLName` = reverse-DNS id, `CFBundleURLSchemes` = `["myapp"]`). macOS Launch Services resolves `myapp://...` to the default handler, **launches the app if not running**, and delivers the URL via Apple Events (`kAEOpenURL`), surfacing as `application(_:openURLs:)` in AppKit ([Apple, Defining a custom URL scheme](https://developer.apple.com/documentation/xcode/defining-a-custom-url-scheme-for-your-app) — page is JS-walled to scrapers; the plist keys and Apple-Events delivery are stable, long-documented behavior, verify wording against Xcode docs before shipping). If another app claimed the scheme first, first-registered wins; the user can change the default handler.

How the incumbents do it:

- **VS Code**: `vscode://file/{path}`, `vscode://file/{path}:line:col`, `vscode://settings/...`; "you can pass the vscode:// URL directly to … browsers or file explorers that can parse and redirect the URL"; Insiders uses `vscode-insiders://` ([VS Code command line](https://code.visualstudio.com/docs/editor/command-line#_advanced-command-line-options)). Extensions can register per-extension handlers (`vscode.window.registerUriHandler`, URI form `vscode://publisher.extension/...`) — that page (`/api/references/uri-handler`) 404'd to our fetcher on 2026-09-04; treat the mechanism as documented but re-verify.
- **Zoom** is the canonical `zoommtg://` case (join-meeting deep link → local app). Zoom's own docs URL for it has moved repeatedly (our fetch of `developers.zoom.us/docs/meeting-sdk/windows/url-schemes/` 404'd on 2026-09-04) — evidence that scheme docs are churny, not that the pattern is dead.
- **Linear/GitHub Codespaces** use **https deep links** rather than custom schemes where possible: Codespaces opens a machine via `https://CODESPACE-NAME.github.dev` (web client) or `https://github.com/codespaces/NAME?editor=vscode` (desktop), with the note "only you can open your own codespaces" ([GitHub docs](https://docs.github.com/en/codespaces/developing-in-a-codespace/opening-an-existing-codespace)).

Assessment:

- **Setup burden:** highest of the browser-reachable options — you must ship, sign, and (if not via Homebrew) notarize a `.app`, and it must be launched once so Launch Services registers the scheme.
- **Security:** schemes are unauthenticated and unverified — any app can claim a scheme (Apple's own guidance prefers universal links for this reason). The helper must treat URL parameters as untrusted input (whitelist commands; never `sh -c` the URL body). The browser does show the native "open in …?" prompt, which is a weak user consent gate.
- **Streaming output back to UI:** none. `location.href = 'myapp://run?…'` is fire-and-forget; to get results back you need the section-3 local server anyway — at which point the scheme is redundant.
- **Maintenance:** an entire native app target (Swift/AppKit or Electron-lite) for a button.

## 2. Browser extension + native messaging

Chrome's model ([Native messaging, developer.chrome.com](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)):

- A **native messaging host manifest** (JSON: `name`, `description`, absolute `path` to the host binary on macOS, `type: "stdio"`, `allowed_origins` listing extension IDs — "the values of allowed-origins cannot contain wildcards") is installed to `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` (user) or `/Library/Google/Chrome/NativeMessagingHosts/` (system); separate trees for Chromium/Edge.
- Chrome spawns the host per `runtime.sendNativeMessage()` (process-per-message; first host message is the reply) or keeps it alive for the port's lifetime with `runtime.connectNative()`. Protocol: JSON over stdio with a native-endian 32-bit length prefix; host→Chrome messages capped at **1 MB**, Chrome→host at **64 MiB**; debugging must go to stderr.
- Requires the `nativeMessaging` extension permission; content scripts cannot call it (they relay via the extension's service worker).

**Can a webpage trigger it? Not directly — but effectively yes via relay.** Per the messaging docs ([developer.chrome.com](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)), a webpage on an `externally_connectable.matches` origin can call `chrome.runtime.sendMessage(extensionId, msg)` (guarded by `if (chrome && chrome.runtime)`); the extension receives it in `onMessageExternal` and forwards to the native host. So: page → extension service worker → host binary → CLI. The reverse direction is restricted ("it is not possible to send a message from an extension to a web page"), but the port/`postMessage` channel gives you streaming back through the content-script relay.

Assessment: solid security model (origin allowlist + extension review + host allowlist), real streaming, but **setup burden** = install extension from store _and_ run a host-manifest installer; **maintenance** = extension + host + Firefox/Safari parity (Firefox supports the same protocol with its own manifests and `allowed_extensions`).

## 3. Local daemon on 127.0.0.1 (recommended)

A small helper (Node/Bun script, run via `brew services`/`launchd`/`npx workbench-helper`) listens on `127.0.0.1:PORT` with a strict CORS allowlist on our UI origin; the page `POST /run { command: "coderabbit-review", pr: 123 }` and streams output over SSE/WebSocket.

- **Security — DNS rebinding is the threat that matters.** A malicious page can rebind its DNS to `127.0.0.1` after first load, satisfying same-origin policy while its JavaScript talks to your unauthenticated local server ([GitHub Engineering, "Localhost dangers: CORS and DNS rebinding"](https://github.blog/security/application-security/localhost-dangers-cors-and-dns-rebinding/)). Mitigations, per that post: (1) require auth on sensitive endpoints (rebound requests "cannot contain cookies"/tokens of your app), (2) **validate the `Host` header** against an approved local name, (3) check `Origin` against an allowlist. Practically: bind loopback only, require a per-install bearer token (written to `~/.workbench/helper-token` and injected into the UI via the Worker, or exchanged at pairing time), reject non-allowlisted `Origin`/`Host`, and make the API **schema-typed, enumerated commands** — never accept an arbitrary command string from the page (that's remote code execution by design).
- **Streaming:** trivial — SSE/WS chunked stdout straight into the UI. Claude-Code-style `stream-json` (below) maps 1:1 onto this.
- **Setup burden:** one `npx`/`brew` command; no app bundle, no notarization (notarization is a Gatekeeper requirement for _distributed apps_, not for scripts the user runs themselves — see Apple Developer notarization docs).
- **Maintenance:** one small TypeScript program; can live in this repo (`scripts/` or a `packages/helper`), reusing our Effect stack.

This is also the architecture of every dev tool our users already trust: Vite/dev servers on localhost, and ttyd (below) by default.

## 4. Terminal-in-browser: ttyd / xterm.js + node-pty

[ttyd](https://github.com/tsl0922/ttyd) ("a simple command-line tool for sharing terminal over the web", MIT, 12.3k stars) runs a command in a PTY and serves it over WebSocket, rendered with **xterm.js/WebGL2**. Straight from the README: `ttyd bash` (port **7681**, read-only by default), `-p/--port`, `-c user:pass` basic auth, `-W/--writable` to let clients type, `-S/-C/-K` for TLS, `-m` max clients, `-O/--check-origin` to "block cross-origin WebSockets", `-i` to bind an interface **or a Unix socket**. The `-O` and `-i` flags are exactly the origin-check/loopback hygiene from §3.

Use here: the helper spawns `ttyd -p 0 -c :$TOKEN zsh` (or embeds xterm.js + node-pty directly in our own helper), and the PR page renders the live review in an embedded terminal. Options in the family: wetty (Node), GoTTY (Go) — both listed as ttyd alternatives in its README. This is the only option where the user _sees their terminal_ running the command, which matches the stated desire ("runs on their Mac terminal").

Trade-offs: interactive shell in the browser is a bigger attack surface than an enumerated-command API; read-only mode + token + origin check mitigates. Best treated as an optional _view_ layered on the §3 helper, not the trigger mechanism itself.

## 5. Existing products / protocols

- **VS Code URIs from the browser:** `window.open('vscode://file/...')` is fully documented ([VS Code CLI docs](https://code.visualstudio.com/docs/editor/command-line#_advanced-command-line-options)). If the user has VS Code installed, a "Review in VS Code" button is free — but it opens an editor, not our CLI.
- **Codespaces:** deep links + `gh codespace code|ssh` exist ([docs](https://docs.github.com/en/codespaces/developing-in-a-codespace/opening-an-existing-codespace)), but execution happens in a cloud machine — wrong locality for "on my Mac with my local `gh` auth and my zcode login".
- **tmux send-keys:** the classic "web button → terminal" hack — helper runs `tmux send-keys -t workbench "coderabbit review --agent" Enter` and output appears in the user's existing tmux pane ([tmux source/man pages](https://github.com/tmux/tmux)). Zero new UI, but requires tmux and gives the web UI no structured feedback. Reasonable v0: helper shells `osascript`/`tmux send-keys` for visibility while also capturing stdout itself.
- **CodeRabbit CLI — exact invocation** ([docs.coderabbit.ai/cli](https://docs.coderabbit.ai/cli), [headless integration](https://docs.coderabbit.ai/cli/headless-cli-integration)):
  - Install: `curl -fsSL https://cli.coderabbit.ai/install.sh | sh`, `brew install coderabbit` (cask: [formulae.brew.sh/cask/coderabbit](https://formulae.brew.sh/cask/coderabbit)).
  - Auth (headless, Agentic API key required — user API keys are rejected): `coderabbit auth login --api-key "$CODERABBIT_API_KEY"`, or per-call `coderabbit review --api-key "$CODERABBIT_API_KEY"`; `--region eu` as needed; `coderabbit auth status` to check.
  - Review: must run **inside a Git worktree**; there is no documented review-by-PR-URL. For a PR: `git fetch origin pull/123/head && git checkout FETCH_HEAD`, then `coderabbit review --agent --base main` (also `--uncommitted`, `--include-untracked`, `--light`, `--committed`). `--agent` emits structured JSON for tooling; over-limit reviews in headless mode return an `awaiting_confirmation` structured result instead of prompting. `cr doctor` verifies install/auth/connectivity — ideal helper health-check.
- **zcode headless — exact invocation** (primary: `zcode --help` run locally, v0.16.5, `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`): `zcode --prompt "<text>"` runs a single prompt without the TUI (`-p/--print` positional form also exists); relevant flags: `--mode build|edit|plan|yolo` (**default `yolo` for `--prompt`** — full auto, i.e. it will run tools/edits unprompted; pin `--mode plan` for read-only review), `--allowed-tools`/`--disallowed-tools`, `--cwd <path>`, `--attach <file>` (repeatable), `--resume <sessionId>`, `--continue`, `--json`, `--target`. Auth via `zcode login` (Z.AI OAuth). **Verified failure mode:** a bare `zcode.cjs --prompt …` outside the desktop app errors with `Error: Model config is missing. Create ~/.zcode/cli/config.json with an explicit model provider before running ZCode` — the helper must ensure `zcode login`/provider config exists (surface a "run `zcode login`" instruction on first use). Also verified: the parser rejects some help-advertised combos in odd ways (e.g. `--max-turns` alongside `-p`/`--prompt` errored as "Unknown option" on 0.16.5) — smoke-test the exact flag set the helper uses and pin the version.
- **Claude Code headless (reference pattern;** [code.claude.com/docs/en/headless](https://code.claude.com/docs/en/headless)): `claude -p "prompt"` non-interactive; `--output-format text|json|stream-json` (`stream-json` + `--verbose --include-partial-messages` for token streaming); `--allowedTools "Bash,Read,Edit"` and rule syntax `Bash(git diff *)`; `--permission-mode auto|dontAsk|acceptEdits`; `--permission-prompts none` for unattended runs; `--bare` skips hooks/skills/plugins/CLAUDE.md (API key only); session resume via `--resume "$session_id"` where `session_id` comes from JSON output; piped stdin capped at 10 MB. This is the shape zcode's `--prompt`/`--json`/`--resume` mirrors — the helper should consume CLIs via `stream-json`-style NDJSON for live progress.

## 6. Fallback: server-side execution via GitHub Actions

The Worker calls `POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches` with `{"ref": "...", "inputs": {...}}` (workflow must declare `workflow_dispatch`; classic tokens need `repo` scope; response 200 returns `workflow_run_id`) ([GitHub REST reference](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)). A workflow checks out the PR and runs the identical `coderabbit review --agent` / `zcode --prompt` commands with `CODERABBIT_API_KEY` etc. as Actions secrets; progress is observable via the runs API, and "post GitHub comments" is natural there (`GITHUB_TOKEN` with `pull_request: write`). This is the progressive-enhancement tier: button works for everyone; when the local helper answers its health check on `127.0.0.1`, the UI prefers local execution (user's zcode login, their model quota, visible terminal).

## Comparison

| Option                                         | End-user setup                                 | Security                                                                         | Streams output to UI                  | macOS specifics                                                 | Maintenance                              |
| ---------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------- | ---------------------------------------- |
| 1. Deep link + native app                      | Install+launch a signed `.app`                 | Weak: scheme squatting, unverified URL args, browser prompt only                 | No (fire-and-forget; needs §3 anyway) | LaunchServices, `CFBundleURLTypes`, notarization if distributed | High (native target)                     |
| 2. Extension + native messaging                | Extension from store + host-manifest installer | Strong: origin allowlist, no wildcards, host allowlist                           | Yes (via port relay)                  | Per-browser manifest paths                                      | High (extension + host + Firefox parity) |
| 3. Local daemon on 127.0.0.1 **(recommended)** | One `npx`/`brew` command                       | Good, if: loopback bind, token auth, Host/Origin validation, enumerated commands | Yes, natively (SSE/WS)                | None beyond launchd/brew services                               | Low (TS in this repo)                    |
| 4. ttyd / xterm.js view                        | Same as §3 (it's the helper's UI layer)        | Good with `-O`/`-c`/token; read-only default                                     | Yes — real terminal rendering         | None                                                            | Low-medium                               |
| 6. Actions `workflow_dispatch`                 | None                                           | GitHub-native (secrets, tokens)                                                  | Yes via runs API/jobs logs            | None                                                            | Low (one workflow file)                  |

## Recommended architecture for this repo

1. **Helper** (`scripts/helper.mjs` or `packages/helper`, Node ≥ 22): HTTP server bound to `127.0.0.1:<fixed port>`; requires `Authorization: Bearer <token>` from `~/.workbench/helper-token`; validates `Origin` is our deployed UI and `Host` is `127.0.0.1:<port>`; exposes only `GET /health`, `POST /review { engine: "coderabbit"|"zcode", pr: number }`. Each engine is a typed module that shells out (execa is already a known-good pattern; `npm view execa` shows v10.0.1, actively maintained) to the verified commands:
   - coderabbit: `git fetch origin pull/<n>/head && git checkout FETCH_HEAD && coderabbit review --agent --base <default branch>` (API key from env/keychain).
   - zcode: `zcode --prompt "<review prompt for PR n>" --mode plan --cwd <repo> --json`, then post comments via `gh pr review --comment`/REST using the user's local `gh` auth.
2. **Streaming:** NDJSON stdout from `--agent`/`--json` piped to the response as SSE; the TanStack frontend renders findings incrementally.
3. **Trigger UX:** button first probes `GET /health` (short timeout) → local run; otherwise the Worker calls `workflow_dispatch` on the same engine scripts kept in `.github/workflows/review.yml` so both tiers run literally the same commands.
4. **Optional visibility layer:** `GET /terminal` upgrading to WebSocket into a node-pty session (ttyd-style, read-only) for users who want to watch it in a terminal pane.

## Open items

- CodeRabbit review-by-PR-URL is absent from the CLI docs as of 2026-09-04; the checkout-then-review flow is the documented path. If CodeRabbit ships a PR-mode command, the helper's coderabbit module simplifies.
- zcode 0.16.5 rejected `--max-turns` in practice despite advertising it; pin and smoke-test the exact invocation in CI (a `zcode doctor`-equivalent `--help` assertion).
- `zcode login` flow for headless-only users (does OAuth device flow work from `--no-browser`? — the flag exists on `login`; untested here).
