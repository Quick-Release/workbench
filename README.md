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

The app does not call GitHub, include credentials, query a ticket database, or
mutate remote issues. Links point to the detected repository remote for source
reading only.
