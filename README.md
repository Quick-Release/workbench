# Workbench

A read-only TanStack Router/Vite workbench for a bird's-eye view of a
repository's planning and development work. It is designed to run as a
standalone repository or as a Git submodule mounted at `apps/workbench`.

## Run it from a host repository

After initializing the submodule and installing the host workspace:

```sh
git submodule update --init apps/workbench
pnpm install
pnpm run workbench
```

This launches Workbench on <http://localhost:4051>. The host command runs the
snapshot sync against the host repository. If the host does not provide a root
alias, run the app directly:

```sh
pnpm --dir apps/workbench dev
pnpm --dir apps/workbench sync
```

The submodule automatically detects its superproject as the source repository.
Set `WORKBENCH_SOURCE_ROOT=/path/to/repository` when running the standalone
repository against a different checkout. `WORKBENCH_PROJECT_NAME` and
`WORKBENCH_REPOSITORY_URL` can override the detected project metadata.

## Configuration

Copy `workbench.config.example.json` to `workbench.config.json` in the host
repository. The JSON schema is available at `workbench.config.schema.json`.
The config controls project metadata, semantic theme colors, and read-only
service snapshots:

```json
{
  "$schema": "./apps/workbench/workbench.config.schema.json",
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

Supported service adapters are currently `asana` (project tasks) and `notion`
(data-source pages). Tokens are read only from the named environment variables
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
