---
description: Use this skill when setting up a repository that uses the Effect
  TypeScript library.
---

# Step 1: Install effect

Use the user's preferred package manager:

```
pnpm add effect@rc
```

If in a monorepo, install it as a dev dependency at the root, so you can access
the source code from `node_modules/effect/src`.

```
pnpm add -D effect@rc
```

# Step 2: Update AGENTS.md / CLAUDE.md

Ensure that the agent instructions contain the following:

```md
# Learning more about Effect

This repository uses the Effect TypeScript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect APIs and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.
```
