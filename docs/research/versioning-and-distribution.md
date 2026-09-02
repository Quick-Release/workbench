# Research: SemVer versioning and dependency-based distribution for Workbench

> **Preamble:** the repo keeps docs under `docs/` (`docs/agents/`, per `AGENTS.md`) but has no research-document convention yet; this file establishes `docs/research/` as that convention. All claims about external tooling cite primary sources (semver.org, docs.npmjs.com / npm/cli source, docs.github.com, pnpm.io, the changesets, changesets/action, googleapis/release-please and googleapis/release-please-action READMEs, semantic-release docs). Claims about this repo cite repo file paths and were verified by reading the files on 2026-09-02.

---

## 0. Summary / recommendation

**Observed facts that drive everything below**

- `gh repo view Quick-Release/workbench --json name,owner,visibility,isPrivate` returned: `"isPrivate":true`, `"visibility":"PRIVATE"`, owner login **`Quick-Release`**. The repo is private.
- The package is `@banquinha/workbench` with `"private": true` (`package.json`) — the npm scope `@banquinha` does **not** match the GitHub owner `Quick-Release`, and GitHub Packages' npm registry documents scoped names as `@NAMESPACE/PACKAGE-NAME` where "NAMESPACE" is "the name of the user or organization account to which the package will be scoped" ([GitHub docs, "Working with the npm registry"](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)). Any GitHub-Packages path therefore requires a scope rename to `@quick-release/workbench`.
- Workbench is an **app, not a library**: its `dev`/`sync` scripts require the `vp` binary (vite-plus), and `sync` writes `src/data.generated.ts` _inside the package directory_ (`package.json` scripts; `scripts/sync-data.mjs:8,37`). Distribution strategy must account for this (Section 4).

**Recommendation**

1. **Versioning workflow: Changesets + `changesets/action`**, starting at **0.1.0** (semver `0.y.z` initial development). Contributors add a changeset file in each PR; the action opens a "Version Packages" PR; merging it bumps the version, writes the CHANGELOG, publishes, and creates a git tag + GitHub release. Explicit intent, lowest ceremony, monorepo-ready, and it produces the git tags that every distribution channel below consumes.
2. **Distribution channel (primary): GitHub Packages npm registry, as `@quick-release/workbench`**, installed by hosts with a pinned version (e.g. `"@quick-release/workbench": "0.2.1"`). Publish with the repo's `GITHUB_TOKEN` (`packages: write`); hosts install with an org-scoped `.npmrc` token entry.
3. **Distribution channel (fallback, zero registry setup): git-tag dependency** — `pnpm add github:Quick-Release/workbench#semver:^0.2.0`. pnpm resolves `#semver:` against the repo's git tags; anyone who can already clone the private repo can install it via ordinary git auth (SSH `insteadOf` rewrite or HTTPS credential helper, per pnpm docs).
4. **Packaging shape: ship source + a `bin` wrapper**, with the toolchain packages (`vite-plus`, `vite`, `vitest`, `@tanstack/router-plugin`, `@vitejs/plugin-react`, `typescript`) moved into `dependencies`, because the host must run the app's own dev/build tooling and `devDependencies` are not installed for consumers ([npm package.json docs](https://docs.npmjs.com/cli/v11/configuring-npm/package-json)). Replace `catalog:` references with plain versions in the published manifest (safe under both `pnpm publish` — which strips `catalog:` at pack time — and any npm-based publish path, which does not).

---

## 1. SemVer fundamentals (semver.org)

From [Semantic Versioning 2.0.0](https://semver.org/) (spec text also mirrored at [semver/semver `semver.md`](https://raw.githubusercontent.com/semver/semver/master/semver.md)):

- A version is `X.Y.Z` — "MAJOR.MINOR.PATCH". "Increment the: MAJOR version when you make incompatible API changes, MINOR version when you add backwards compatible functionality, PATCH version when you make backwards compatible bug fixes." (Summary + items 7–9.)
- **Item 4 (initial development):** "Major version zero (0.y.z) is for initial development. Anything MAY change at any time. The public API SHOULD NOT be considered stable."
- **Item 2 (immutability):** "Once a versioned package has been released, the contents of that version MUST NOT be modified. Any modifications MUST be released as a new version." — this is the core argument for _tagged, pinned_ distribution over submodule-at-head.
- **FAQ "How do I know when to release 1.0.0?":** "If your software is being used in production, it should probably already be 1.0.0. If you have a stable API on which users have come to depend, you should be 1.0.0… The simplest thing to do is start your initial development release at 0.1.0." (Spec FAQ, item 11.)

**Which version to start at for this tool:** start at **0.1.0**. Workbench's "public API" for consumers is its runtime contract: the `sync` script's host expectations (`docs/plans/**`, `openspec/changes/*`, `workbench.config.json` — `scripts/sync-data.mjs:34-36`, `scripts/config.mjs:138-140`), the env vars (`WORKBENCH_SOURCE_ROOT`, `WORKBENCH_PROJECT_NAME`, `WORKBENCH_REPOSITORY_URL` — `scripts/sync-data.mjs:30`, `scripts/sync-data.mjs:402-405`), and (if shipped) the `bin` entry. Breaking any of those in 0.y.z is a MINOR-or-PATCH judgment call you are allowed to make; move to 1.0.0 once the first host repo depends on it in steady use (per the FAQ's production-use criterion).

---

## 2. Version-bump workflow automation

|                                       | (a) manual `npm version`                                                   | (b) Changesets                                                                                                                                               | (c) release-please                                                                                                    | (d) semantic-release                                                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Decides next version how              | You decide and run `npm version minor` etc.                                | You declare a bump type per change in a changeset file; `changeset version` aggregates them                                                                  | Parsed from **Conventional Commits** in history: `fix:` → patch, `feat:` → minor, `feat!:`/`BREAKING CHANGE:` → major | Fully automatic from commit messages (default: Angular/Conventional Commits conventions)                                      |
| Process burden (small team)           | Lowest tooling, but discipline + memory required; easy to forget changelog | One file per PR (a few lines); release is "merge the Version PR"                                                                                             | Zero per-PR action, but every commit must follow Conventional Commits                                                 | Zero per-PR action, but commit messages _are_ the release API — bad messages = wrong versions, and it releases without review |
| Changelog                             | None (roll your own)                                                       | Generated from changeset content                                                                                                                             | Generated from commit history                                                                                         | Generated from commit history                                                                                                 |
| Monorepo-friendliness                 | Manual                                                                     | First-class ("bumping dependencies of changed packages" — [intro doc](https://github.com/changesets/changesets/blob/main/docs/intro-to-using-changesets.md)) | Manifest config supports multiple packages in one repo                                                                | Single release train per repo; multi-package needs extra tooling (not verified here)                                          |
| Fit for a single-package internal app | OK for a solo tool; no automation                                          | **Best fit**                                                                                                                                                 | Good fit if you already write Conventional Commits                                                                    | Overkill; automation without a human gate                                                                                     |

Details and sources:

- **(a) `npm version`:** "Run this in a package directory to bump the version and write the new data back to package.json and, if there is one, package-lock.json"; "If run in a git repo, it will also create a version commit and tag." Flags: `--no-git-tag-version` skips the commit/tag, `-m` customizes the commit message, and `from-git` takes the version from an existing tag. Source: [docs.npmjs.com `npm version`](https://docs.npmjs.com/cli/commands/npm-version). Nothing here automates changelogs, publishing, or PR flow.
- **(b) Changesets:** a changeset records "a version type (following semver), and change information to be added to a changelog" — "key decisions when they are making their contribution" ([Intro to using Changesets](https://github.com/changesets/changesets/blob/main/docs/intro-to-using-changesets.md)). `changeset version` "consumes all changesets", bumps versions and writes changelog entries; `changeset publish` "will run npm publish in each package that is of a later version than the one currently listed on npm" (same page). The [changesets/action](https://github.com/changesets/action) automates the loop: it "creates a pull request with all of the package versions updated and an up-to-date changelog entry" when there are new changesets on main, and **merging that PR runs the publish script** and (default `createGithubReleases: true`) creates GitHub releases; it normally writes a `.npmrc` with `//registry.npmjs.org/:_authToken=${NPM_TOKEN}` but **skips creation if a `.npmrc` already exists** at the repo root (README) — which is exactly how we redirect it at GitHub Packages in Section 5.
- **(c) release-please:** "Release Please automates CHANGELOG generation, the creation of GitHub releases, and version bumps for your projects", driven by Conventional Commits; merging the standing Release PR "Tags the commit with the version number" and "Creates a GitHub Release based on the tag" ([googleapis/release-please README](https://github.com/googleapis/release-please)). The [release-please-action](https://github.com/googleapis/release-please-action) v4 needs only a token and `release-type: node`, with `contents: write`, `issues: write`, `pull-requests: write` permissions (README includes the exact workflow yaml); note its documented caveat that releases/PRs created with `GITHUB_TOKEN` won't trigger other workflows. Requires the team to keep `feat:`/`fix:` discipline; it does **not** publish to npm registries by itself (README: it deliberately doesn't publish to package managers).
- **(d) semantic-release:** "Fully automated version management and package publishing"; it "uses the commit messages to determine the consumer impact of changes in the codebase" (`fix` → patch, `feat` → minor, `BREAKING CHANGE:` → major), then runs Analyze commits → Create Git tag → Publish → Notify, with "no human directly involved in the release process". Requires CI with credentials ([semantic-release docs](https://semantic-release.gitbook.io/semantic-release/)). For a dashboard consumed by coworkers, fully unattended breaking bumps (and publishing every push) is more machinery than the problem needs.

**Recommendation: Changesets.** It matches this repo's PR-review-heavy process (intent is reviewed _in_ the PR), needs no commit-message convention retrofit, produces both the registry publish **and** the git tags/releases that the fallback git-tag channel needs, and scales if the package ever joins a pnpm workspace with other publishable packages. Start at `0.1.0`.

---

## 3. Distribution channels for a pinned install (no submodules)

Hosts need: `pnpm add <something>` that pins a SemVer version, in repos of the same org. Options verified below.

### a. npm package on GitHub Packages (`npm.pkg.github.com`)

Primary docs: ["Working with the npm registry"](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry), ["About permissions for GitHub Packages"](https://docs.github.com/en/packages/learn-github-packages/about-permissions-for-github-packages).

- **Scope/owner rule:** "GitHub Packages only supports scoped npm packages." "Scoped packages have names with the format of `@NAMESPACE/PACKAGE-NAME`." and "Replace `NAMESPACE` with the name of the user or organization account to which the package will be scoped." The page's examples set `@octocat/test` for user `octocat` and `@my-org/test` for org "My-org". **Consequence for us:** the scope must be `@quick-release` (the GitHub owner, verified via `gh repo view`: owner login `Quick-Release`), not `@banquinha`. The docs pages fetched state the rule via the NAMESPACE placeholder and examples rather than an explicit "scope must equal repo owner" sentence with an error message — see [Unverified](#7-unverified--open-questions) for the residual risk, but the rename is required under any reading.
- **Publishing auth:** "GitHub Packages only supports authentication using a personal access token (classic)" and "You must use a personal access token (classic) with the appropriate scopes to publish and install packages." `.npmrc` lines: `@NAMESPACE:registry=https://npm.pkg.github.com` and `//npm.pkg.github.com/:_authToken=TOKEN`.
- **CI auth:** use "`GITHUB_TOKEN` to publish packages associated with the workflow repository" — repos publishing via Actions workflows are "automatically granted `admin` permission to packages in the repository"; installing from a workflow for packages in _other_ private repos takes "a personal access token (classic) with at least `read:packages` scope" unless that repo has been granted access to the package. Packages "automatically inherit[] the access permissions of the linked repository", and "When you first publish a package, the default visibility is private."
- **Consumer setup:** host `.npmrc` needs the `@quick-release:registry=…` mapping plus an auth token line; then `pnpm add @quick-release/workbench@<pinned>` resolves like any registry package (pnpm reads the same `.npmrc` config as npm).
- **Costs:** classic PATs are legacy-flavored; every host repo needs registry config + token in CI; package must be publishable (no `"private": true` — see b).

### b. npm package on the public npmjs.com registry

Primary docs: [`npm publish`](https://docs.npmjs.com/cli/commands/npm-publish), [`package.json`](https://docs.npmjs.com/cli/v11/configuring-npm/package-json), [`--access` default in npm config source](https://github.com/npm/cli/blob/latest/workspaces/config/lib/definitions/definitions.js).

- `package.json` changes required: remove `"private": true` — "If you set `\"private\": true` in your package.json, then npm will refuse to publish it." (`package.json` docs, `private` field). If you want to pin to a specific registry, "use the `publishConfig` dictionary … to override the `registry` config param at publish-time" (`publishConfig` supports "the tag, registry or access").
- **Access:** the default is "'public' for new packages, existing packages it will not change the current level" (npm `@npmcli/config` definitions, which generate the CLI's docs); to keep a scoped package non-public you must set `--access=restricted`. **A public registry publish therefore makes the code publicly viewable — incompatible with this private internal tool.** (A paid npm org could publish it restricted, at ongoing cost and vendor lock-in.)
- `npm publish` includes only the `files` allowlist ("If there is a `files` list in package.json, then only the files specified will be included"); `package.json`, `README`, `LICENSE`, `main` and `bin` files are always included; `node_modules` and `pnpm-lock.yaml` are always excluded (`package.json` docs, `files` section).
- Verdict: rejected for a private tool unless the org wants it world-readable.

### c. Install straight from git tags

Primary docs: [npm `package.json` → "Git URLs"](https://docs.npmjs.com/cli/v11/configuring-npm/package-json), [pnpm "Supported package sources"](https://pnpm.io/package-sources), [pnpm `update`](https://pnpm.io/cli/update).

- **SemVer resolution:** npm: "If the commit-ish has the format `#semver:<semver>`, `<semver>` can be any valid semver range or exact version, and npm will look for any tags or refs matching that range in the remote repository, much as it would for a registry dependency." pnpm: "You can specify version (range) to install using the `semver:` parameter" — e.g. `#semver:1.0.0`, `#semver:^2.0.0`, `#semver:v0.0.7`. So `pnpm add github:Quick-Release/workbench#semver:^0.2.0` resolves the highest tag satisfying the range. (Without a fragment, you get the default branch head — pnpm docs show `pnpm add kevva/is-positive` installs "the latest commit on default branch"; always use `#semver:` or an explicit `#vX.Y.Z` tag.)
- **Auth (private repo):** pnpm "shells out to git", so ordinary git auth works: SSH via `git config --global url."git@github.com:".insteadOf https://github.com/`, or an HTTPS credential helper; pnpm notes "the lockfile is identical either way" and (v12) records "a git resolution over the canonical HTTPS URL". Locally, developers who can clone the org's repos already have this; in CI, provide the runner a deploy key/PAT through git config.
- **Lockfile pinning:** the lockfile records the git resolution (canonical HTTPS URL + resolved ref/sha per pnpm's docs above), so repeated `pnpm install --frozen-lockfile` in host CI reproduces the same commit even under a range spec.
- **Updating:** "pnpm update updates packages to their latest version based on the specified range" ([pnpm update](https://pnpm.io/cli/update)) — bump the pin with `pnpm up @banquinha/workbench` (or edit the spec) to re-resolve `#semver:` to a newer tag.
- **Build flow:** npm documents that when a git dependency "uses workspaces, or if any of the following scripts are present: build, prepare, prepack, preinstall, install, postinstall", the repo "cloned into a temporary directory, all of its deps installed, relevant scripts run, and the resulting directory packed and installed" (`package.json` docs). Our repo has a `pnpm-workspace.yaml` (`packages: [.]`) and `build`/`install`-adjacent flows, so a full build install happens — meaning the app's toolchain gets installed for git deps even while these are `devDependencies`. That makes the git channel work with almost no packaging changes, at the cost of a heavier install. pnpm classifies git and tarball sources as "exotic" — "Exotic sources are useful for development but may pose supply chain risks when used by transitive dependencies" (they're fine as _direct_ deps like ours, and `blockExoticSubdeps` exists if you want a hard guarantee).
- **Gotcha:** this repo's `pnpm-workspace.yaml` uses `catalog:` (`vite-plus: "catalog:"` etc., `package.json:28-30`); whether a git-dep's own `catalog:` resolves during the consumer's build-install is not covered by the pnpm pages fetched (see [Unverified](#7-unverified--open-questions)). Mitigation: replace `catalog:` with plain versions in `package.json` (Section 4.2).

### d. GitHub Release asset tarballs

Primary docs: ["About releases"](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases), pnpm [package-sources](https://pnpm.io/package-sources).

- Mechanics: Releases "are based on Git tags"; "GitHub will automatically include links to download a zip file and a tarball"; a release may carry up to 1000 assets, each ≤ 2 GiB. `pnpm add <url>` accepts remote tarballs: "The argument must be a fetchable URL starting with `http://` or `https://`." So `pnpm add https://github.com/Quick-Release/workbench/releases/download/v0.2.0/banquinha-workbench-0.2.0.tgz` (an `npm pack` artifact uploaded via `gh release upload`) is a valid pinned install.
- **Auth:** "Anyone with read access to a repository can view and compare releases" — on a **private** repo that is only org members/blessed collaborators, so asset URLs are not anonymously fetchable; how npm/pnpm would attach credentials to an arbitrary `github.com` asset URL is not documented on the pages fetched (registry `.npmrc` auth keys off the _registry_ host, not `github.com`). Treat this channel as impractical for private repos without token-in-URL hacks; it would be fine if the repo were public.
- Also note: release zips/tarballs of the _repo_ (the auto-generated archives) contain the source tree, not a packed npm package — you must attach an `npm pack`ed `.tgz` asset for this to be an npm-installable artifact.

### e. Rejected / out-of-scope alternatives

- **pnpm workspace `link:` / `workspace:`:** unversioned by construction (points at a local checkout), defeats the pinned-SemVer goal; also the hosts are separate repos, not this workspace.
- **Vendoring scripts:** no versioning, no updates, drift.
- **Docker image on ghcr.io:** appropriate for server-like tools; wrong here — workbench must read the _host repo's working tree_ (`docs/plans/**`, `openspec/changes/*` — `scripts/sync-data.mjs:34-36`) and run _host-side_ git metadata queries (branch, commit, remote origin — `scripts/sync-data.mjs:400-413`). A container would need the host tree mounted and the host's git identity inside it; the payoff over a plain npm/git install is negative for a local dev dashboard.

### Comparison table

| Channel                                      | SemVer pinning                                     | Host install auth                                                                          | Extra package.json work                                                     | Works with app-shaped repo                                        | Verdict                                |
| -------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------- |
| GitHub Packages (`@quick-release/workbench`) | Registry ranges/exact                              | `.npmrc` scope+token; CI `GITHUB_TOKEN` (own repo) or classic PAT `read:packages` (others) | Scope rename, drop `private`, `files`, `publishConfig`, move toolchain deps | Yes, if toolchain moves to `dependencies`                         | **Primary**                            |
| Public npmjs.com                             | Registry ranges/exact                              | None                                                                                       | Drop `private`, `files`, `publishConfig`                                    | Yes                                                               | **Rejected** — publishes code publicly |
| Git tag `#semver:`                           | `#semver:` range vs tags; lockfile pins resolution | Any git auth that can clone (SSH rewrite / credential helper)                              | Almost none (tags only)                                                     | Yes — full build install for workspace/git-dep repos (npm docs)   | **Fallback**                           |
| Release-asset tarball                        | Exact URL per version                              | Private assets need read access; client auth path undocumented                             | Release-asset pipeline                                                      | Awkward auth                                                      | Rejected (private repo)                |
| `link:`/vendoring/Docker                     | none / none / image tag                            | n/a / n/a / ghcr auth                                                                      | small/large                                                                 | link & vendor break pinning; Docker fights host-tree + git access | Rejected                               |

---

## 4. The app-vs-library problem (repo-specific)

### 4.1 Which paths `sync` assumes (verified in files)

`scripts/sync-data.mjs`:

- `appDirectory` = the package root (parent of `scripts/`) — line 8. All outputs go **inside the package**: `outputPath = join(appDirectory, "src/data.generated.ts")` — line 37.
- Source root resolution — lines 24–33: `WORKBENCH_SOURCE_ROOT` env → `git rev-parse --show-superproject-working-tree` → `git rev-parse --show-toplevel` → `process.cwd()`. It reads `{root}/docs/plans/**` (lines 34–35, 418), `{root}/docs/dashboard-plan/status.md` (line 296), `{root}/openspec/changes/*/` (lines 36, 452–457), and loads `workbench.config.json` from the root (`scripts/config.mjs:138-140`).
- Host git metadata queries run with `cwd = rootDirectory`: `remote.origin.url`, `branch --show-current`, `rev-parse HEAD`, `show -s --format=%cI HEAD` (lines 400–413), overridable via `WORKBENCH_REPOSITORY_URL` / `WORKBENCH_PROJECT_NAME`.
- `package.json` scripts chain the app's own tooling: `sync` = `node scripts/sync-data.mjs && vp fmt --write src/data.generated.ts`; `dev` = `pnpm sync && vp dev --port 4051 --strictPort`; `build`/`test`/`check` all run `pnpm sync` first. `vp` comes from `vite-plus`, a **devDependency** resolved through the `catalog:` in `pnpm-workspace.yaml` (→ `npm:@voidzero-dev/vite-plus-core@0.2.8`). `vite.config.ts` imports `defineConfig` from `vite-plus` and pulls `@tanstack/router-plugin` + `@vitejs/plugin-react`; `index.html` mounts `/src/main.tsx` directly — this is a source-mode app, so there is no prebuilt-dist story today; any consumer must run this exact toolchain.

**Consequences when installed as a dependency:**

1. **Toolchain availability:** for a _registry_ package, `devDependencies` are not installed for consumers (npm `package.json` docs: devDependencies are installed "when doing `npm link` or `npm install` from the root of a package"), so `vp`, `vitest`, the router plugin, React plugin and TypeScript would be missing and every script fails. Fix: move them into `dependencies` (the app _is_ the runtime), or ship a prebuilt dist — but a prebuilt dist bakes `src/data.generated.ts` in at build time and sync must regenerate it per host, so shipping source is the realistic option. (For the git-tag fallback channel, the documented build-flow for workspace git deps installs all deps including dev ones, which is why that channel works nearly as-is.)
2. **Superproject detection:** the brief assumed detection breaks inside `node_modules`. Reading the code shows something subtler: `git rev-parse --show-toplevel` walks up to the nearest enclosing `.git`, and a pnpm-installed package (real path under the host's `node_modules/.pnpm/…`, with `import.meta.url` resolving symlinks) is still _inside the host working tree_, so detection likely still finds the host root in the default setup. It breaks when the store/virtual store is relocated outside the project, for global installs, or if the command is run from outside the host tree — that is exactly what the `process.cwd()` fallback (run from host root) and the explicit `WORKBENCH_SOURCE_ROOT` override are for (`scripts/sync-data.mjs:30-33`). Document `WORKBENCH_SOURCE_ROOT` as the supported contract for dependency installs rather than relying on git luck. _(This paragraph is reasoning from git/pnpm behavior plus the code, not an official-docs citation.)_
3. **Writing `src/data.generated.ts` inside `node_modules`:** fragile in principle — `node_modules` is reinstallable and pnpm builds it from its content-addressable store, so anything written there can vanish on the next `pnpm install`. In practice the blast radius is small _for this app_ because every entry point (`dev`, `build`, `test`, `check`) runs `pnpm sync` first, so the file is regenerated before it is ever read. Mitigations, in order of preference: (a) keep as-is but document that the snapshot is disposable; (b) harden later with a host-provided output dir env var (e.g. `WORKBENCH_OUTPUT_DIR`) plus a small runtime indirection so the generated module is read from outside the package; (c) never have sync write anything to the host repo itself (it currently doesn't — README confirms `src/data.generated.ts` is ignored/generated).

### 4.2 `catalog:` at publish time

- pnpm documents: "The `catalog:` protocol is removed when running `pnpm publish` or `pnpm pack`. This is similar to the `workspace:` protocol, which is also replaced on publish." ([pnpm Catalogs](https://pnpm.io/catalogs)), with the replaced manifest showing the concrete range. So **`pnpm publish`** handles it.
- **Gotcha:** Changesets' publish runs npm: "changeset publish will run npm publish in each package …" ([changesets intro](https://github.com/changesets/changesets/blob/main/docs/intro-to-using-changesets.md)) — and nothing in the npm docs says npm understands `catalog:`. If the publish step is plain `npm publish`, `catalog:` would ship verbatim and a host install would fail to resolve it. Workarounds: (a) point the changesets action's `publish` input at a script that runs `pnpm publish --no-git-checks` (pnpm's publish also honors `publishConfig` overrides — [pnpm publish](https://pnpm.io/cli/publish)); or (b) simplest and robust under any publish path: **stop using `catalog:` in `package.json`** and pin plain versions (keep the `catalog`/`overrides` in `pnpm-workspace.yaml` for local dev if still wanted).

### 4.3 What the package must ship, and host scripts

`files` allowlist (npm docs: only listed files are included; `README`/`package.json` always are):

```
"files": [
  "bin.mjs", "scripts", "src", "index.html",
  "vite.config.ts", "tsconfig.json",
  "workbench.config.schema.json"
]
```

Ship **source**, not a prebuilt `dist` — `vite.config.ts` + `index.html` show a source-mode Vite app whose data import is regenerated at sync time, so a consumer must run the app's own `vp dev`/`vp build` anyway.

- Add a `bin` so hosts don't hand-write `pnpm --dir` paths: `"bin": { "workbench": "./bin.mjs" }` (npm docs: `bin` files are linked so consumers can run them "either directly by `npm exec`/`pnpm exec` or by name in other scripts"). `bin.mjs` resolves the source root (`WORKBENCH_SOURCE_ROOT` → `process.cwd()`), runs `node scripts/sync-data.mjs`, then spawns the package-local `vp dev --port 4051 --strictPort`.
- Host `package.json`:

```json
{
  "scripts": {
    "workbench": "workbench"
  },
  "devDependencies": {
    "@quick-release/workbench": "0.2.1"
  }
}
```

(Pin exact versions for an internal app; a `^0.2.0` range in 0.y.z effectively floats until the next breaking-ish minor — semver item 4.)

- Config stays at the **host repo root** (`workbench.config.json`, loaded from the resolved root — `scripts/config.mjs:138-140`); the schema is shipped in the package, so hosts reference `$schema: "./node_modules/@quick-release/workbench/workbench.config.schema.json"` (or the package keeps a copy at the repo root for a stable relative path).

---

## 5. Recommended setup + adoption plan

**Setup: Changesets (start 0.1.0) → publish `@quick-release/workbench` to GitHub Packages via `pnpm publish` in the changesets action; git-tag `#semver:` installs as the documented fallback.**

### Step 1 — `package.json` edits

```jsonc
{
  "name": "@quick-release/workbench", // scope must match the GitHub owner (Quick-Release)
  "version": "0.0.0", // first changeset (minor) → 0.1.0
  // "private": true — DELETE: npm refuses to publish private packages
  "bin": { "workbench": "./bin.mjs" },
  "files": [
    "bin.mjs",
    "scripts",
    "src",
    "index.html",
    "vite.config.ts",
    "tsconfig.json",
    "workbench.config.schema.json",
  ],
  "publishConfig": { "registry": "https://npm.pkg.github.com" },
  "dependencies": {
    // keep existing runtime deps; MOVE these from devDependencies:
    "vite-plus": "0.2.8", // plain versions, not "catalog:" (§4.2)
    "vite": "npm:@voidzero-dev/vite-plus-core@0.2.8",
    "vitest": "4.1.9",
    "@tanstack/router-plugin": "1.168.23",
    "@vitejs/plugin-react": "6.0.5",
    "typescript": "6.0.3",
  },
}
```

### Step 2 — repo `.npmrc` (checked in; makes changesets/action skip its npmjs.org default)

```ini
@quick-release:registry=https://npm.pkg.github.com
```

Scope mapping only — **no token line**. pnpm 11 ignores environment-variable
credentials from a committed project `.npmrc` ("environment variables are not
expanded in registry credentials that come from a project .npmrc", observed
when running `pnpm install` after adoption); the auth token must come from a
user-level config. In CI that is `actions/setup-node` with `registry-url`
(plus the `NODE_AUTH_TOKEN` env var); for humans, the user-level `~/.npmrc`.

### Step 3 — `.github/workflows/release.yml` (sketch)

```yaml
name: Release
on:
  push:
    branches: [main]
permissions:
  contents: write # tags + GitHub releases (createGithubReleases default true)
  packages: write # publish to GitHub Packages with GITHUB_TOKEN
  pull-requests: write # the Version Packages PR
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: pnpm, registry-url: "https://npm.pkg.github.com" }
      - run: pnpm install --frozen-lockfile
      - run: pnpm check
      - uses: changesets/action@v1
        with:
          publish: pnpm run release-publish # script that runs: pnpm publish --no-git-checks (strips catalog:, honors publishConfig)
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NPM_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          # setup-node's registry-url writes the user-level ~/.npmrc auth line
          # against this variable; pnpm expands env vars only from user-level config
          NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Publishing with `GITHUB_TOKEN` is documented for "packages associated with the workflow repository" ([npm-registry page](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)). If any step rejects `GITHUB_TOKEN`, fall back to a classic PAT with `write:packages` in a secret (docs: classic PATs are the supported auth for this registry).

### Step 4 — first release

```sh
git mv-rename scope in package.json; pnpm install          # lockfile refresh
pnpm dlx @changesets/cli add   # "minor" → bumps 0.0.0 → 0.1.0
git commit -am "chore: adopt changesets" && git push
# merge the opened "Version Packages" PR → action publishes 0.1.0 to
# npm.pkg.github.com, pushes tag v0.1.0, creates the GitHub release
```

(If changesets refuses to handle the package while `"private": true` lingers anywhere in config, remove it first; changesets' exact private-package config options are listed as unverified in §7.)

### Step 5 — host repo consumption

```sh
# one-time host .npmrc (user-level or repo-level):
#   @quick-release:registry=https://npm.pkg.github.com
#   //npm.pkg.github.com/:_authToken=<classic PAT with read:packages>
pnpm add @quick-release/workbench@0.2.1        # pinned
pnpm run workbench                              # → bin: sync against host root, serve :4051
```

- In host CI that must install the package: grant the host repo access to the package (packages inherit the linked repo's permissions) or use a classic PAT `read:packages` secret — both per the [npm-registry page](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry).
- Alternative zero-registry install (same tags): `pnpm add github:Quick-Release/workbench#semver:^0.2.1` with normal git auth (pnpm's documented `insteadOf` SSH rewrite or an HTTPS credential helper); update with `pnpm up @quick-release/workbench` (or the github: spec) ([pnpm package-sources](https://pnpm.io/package-sources), [pnpm update](https://pnpm.io/cli/update)).
- `workbench.config.json` stays at the host root; keep the schema discoverable via the package copy.

### What changes in the README consumption story

Replace the submodule instructions ("initialize the submodule… `pnpm --dir apps/workbench dev`") with: (1) `pnpm add @quick-release/workbench@<pin>` plus the scoped-registry `.npmrc` (or the `github:#semver:` one-liner); (2) a host script `"workbench": "workbench"` instead of `pnpm run workbench` shelling into `apps/workbench`; (3) `WORKBENCH_SOURCE_ROOT` documented as the supported way to point at the host root when auto-detection can't see it (dependency installs, standalone checkouts); (4) the schema path moves from `./apps/workbench/workbench.config.schema.json` to the installed package path. The "Sources"/config sections are unchanged — the host-root conventions (`docs/plans/**`, `openspec/changes/`, `workbench.config.json`) are exactly what sync already reads (`scripts/sync-data.mjs:34-36`, `scripts/config.mjs:139`).

---

## 6. Unverified / open questions

- **Scope-mismatch enforcement on GitHub Packages:** the docs pages fetched define NAMESPACE as the owning user/org and give matching examples, but none states an explicit error for publishing `@banquinha/...` to a `Quick-Release` repo (community reports a 400 "package name… must match" error; not verified against docs). The rename to `@quick-release/workbench` is recommended regardless; optionally probe-publish to confirm.
- **Changesets and `"private": true`:** whether `privatePackages: { version: true }` config is needed/available for versioning-without-publishing was not verified from the changesets docs; simplest path is removing `private: true` at adoption.
- **`catalog:` inside a git-tag dependency:** how pnpm treats a git dep whose `package.json` uses `catalog:` (the repo _is_ a pnpm workspace, `pnpm-workspace.yaml`) during the consumer-side build-install was not verified; avoided by shipping plain versions.
- **Auth for release-asset tarball URLs on private repos** from npm/pnpm clients (registry-style `.npmrc` auth keys off the registry host) — no official statement found; channel rejected anyway.
- **semantic-release monorepo support** (multi-package repos needing wrapper tooling) was not verified from its docs; only the single-repo flow was checked.
- **npm `version`'s exact tag name format** (`v`-prefixed vs bare) was not pinned to a docs sentence; irrelevant if tags are created by the release tooling (changesets/release-please).

## 7. Sources

Primary-source pages consulted (all fetched 2026-09-02):

- https://semver.org/ (spec text: https://raw.githubusercontent.com/semver/semver/master/semver.md)
- https://docs.npmjs.com/cli/commands/npm-version (also https://docs.npmjs.com/cli/v11/commands/npm-version)
- https://docs.npmjs.com/cli/commands/npm-publish (also https://docs.npmjs.com/cli/v11/commands/npm-publish)
- https://docs.npmjs.com/cli/v11/configuring-npm/package-json (source: https://raw.githubusercontent.com/npm/cli/latest/docs/lib/content/configuring-npm/package-json.md)
- https://github.com/npm/cli/blob/latest/workspaces/config/lib/definitions/definitions.js (`access` default)
- https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry
- https://docs.github.com/en/packages/learn-github-packages/about-permissions-for-github-packages
- https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases
- https://pnpm.io/package-sources
- https://pnpm.io/catalogs
- https://pnpm.io/cli/publish
- https://pnpm.io/cli/update
- https://pnpm.io/cli/add (redirects git/tarball docs to package-sources)
- https://github.com/changesets/changesets/blob/main/docs/intro-to-using-changesets.md
- https://github.com/changesets/action
- https://github.com/googleapis/release-please
- https://github.com/googleapis/release-please-action
- https://semantic-release.gitbook.io/semantic-release/

Repo files cited: `package.json`, `pnpm-workspace.yaml`, `vite.config.ts`, `index.html`, `README.md`, `scripts/sync-data.mjs`, `scripts/config.mjs` (all under `/Users/valeriovaz/workspaces/getquick/banquinha/tools/workbench/`).
