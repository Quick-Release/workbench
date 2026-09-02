# Workbench

A read-only TanStack Router/Vite workbench for a bird's-eye view of a
repository's planning and development work. It is published as the npm
package `@quick-release/workbench` so host repositories can pin a SemVer
version as a regular dependency instead of tracking a git submodule.

## Install it in a host repository

Workbench is distributed through the GitHub Packages npm registry. One-time
setup — give npm/pnpm the scoped registry and a token with `read:packages`
(user-level `~/.npmrc` or the host repo's `.npmrc`):

```ini
@quick-release:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=<GitHub token with read:packages>
```

Then, in the host repository:

```sh
pnpm add @quick-release/workbench
```

and add a script that runs the installed command:

```json
{
  "scripts": {
    "workbench": "workbench"
  }
}
```

`pnpm run workbench` regenerates the snapshot against the host repository and
launches Workbench on <http://localhost:4051>. Set `WORKBENCH_PORT` to serve
on a different port.

Alternatively, install straight from release tags with no registry setup —
anyone who can already clone this repository can install it:

```sh
pnpm add github:Quick-Release/workbench#semver:^0.1.0
```

The lockfile pins the resolved commit; update with
`pnpm up @quick-release/workbench`.

The `workbench` command detects the host repository by walking up from the
installed package to the enclosing git checkout. Set
`WORKBENCH_SOURCE_ROOT=/path/to/repository` when detection cannot see the
host (standalone checkouts, global installs, relocated package stores).
`WORKBENCH_PROJECT_NAME` and `WORKBENCH_REPOSITORY_URL` can override the
detected project metadata.

## Releases

Versions follow [SemVer](https://semver.org/). To cut a release, describe the
change in a changeset (`pnpm changeset`) inside your PR. After merging, an
automated "Version Packages" PR aggregates the changesets; merging it bumps
the version, writes the changelog, publishes the package to GitHub Packages,
pushes the `vX.Y.Z` tag, and creates the GitHub release.

## Run a standalone checkout

Inside a clone of this repository:

```sh
pnpm install
pnpm dev
```

This launches Workbench on <http://localhost:4051>. Run `pnpm sync` to
regenerate the snapshot only. Set `WORKBENCH_SOURCE_ROOT=/path/to/repository`
to run against a different checkout.

## Configuration

Copy `workbench.config.example.json` to `workbench.config.json` in the host
repository. The JSON schema ships with the package at
`node_modules/@quick-release/workbench/workbench.config.schema.json` (and at
the repository root for standalone checkouts). The config controls project
metadata, semantic theme colors, and read-only service snapshots:

```json
{
  "$schema": "./node_modules/@quick-release/workbench/workbench.config.schema.json",
  "projectName": "Example project",
  "theme": {
    "background": "#101715",
    "accent": "#c5e86c"
  },
  "services": [
    {
      "id": "roadmap",
      "type": "asana",
      "projectGid": "123456789",
      "tokenEnv": "ASANA_TOKEN"
    },
    {
      "id": "tasks",
      "type": "notion",
      "dataSourceId": "00000000-0000-0000-0000-000000000000",
      "tokenEnv": "NOTION_TOKEN"
    }
  ]
}
```

Supported service adapters are `asana` (project tasks, via `projectGid`),
`notion` (data-source pages, via `dataSourceId`), `github` (open issues, via
`repo: "owner/name"`), and `gitlab` (open issues, via a numeric `projectId` or
`projectPath: "group/project"`). The issue adapters derive ticket status from
issue labels (using the same triage vocabulary as local records and any
`statusMap` overrides), and both accept an optional `apiBaseUrl` for
self-hosted instances. Tokens are read only from the named environment variables
while `sync` runs; they are never written to the config or bundled into the
browser. Service failures are reported in the snapshot and do not hide local
Markdown records. Add future providers behind the adapter seam in
`scripts/services/` rather than adding arbitrary browser-side URLs.

## Sources

`scripts/sync-data.mjs` reads local Markdown and produces the ignored,
generated `src/data.generated.ts` snapshot. It recognizes these conventions:

- `docs/plans/**/tickets/*.md` — implementation-ticket records;
- `docs/plans/*/{README,plan,roadmap}.md` — plan-level context and ticket load;
- `docs/dashboard-plan/status.md` — an optional canonical status ledger;
- `openspec/changes/*/{proposal,tasks}.md` — optional specification changes.

Missing optional directories are valid, so the app can be used by repositories
that adopt only part of the conventions. Status labels preserve the canonical
engineering vocabulary when it appears in source Markdown.

The browser app does not call GitHub, include credentials, query a ticket
database, or mutate remote issues. During `sync`, only explicitly configured
Asana or Notion read endpoints are contacted with tokens supplied through the
shell environment. Links point to the detected repository remote for source
reading only.
