#!/usr/bin/env bash
# PreToolUse guard enforcing AGENTS.md "Mandatory isolated development".
#
# Blocks Edit/Write calls whose target file sits inside the canonical
# checkout at /data/code/getquick/internal/workbench. Legitimate edits
# belong in an agent worktree under /data/agents/workspaces/<agent>/.
#
# Contract with the ZCode hook runner: exit 0 = allow, exit 2 = deny.
set -uo pipefail

CANONICAL="/data/code/getquick/internal/workbench"

input="$(cat)" || exit 0

tool="$(jq -r '.tool_name // empty' <<<"$input" 2>/dev/null)" || exit 0
file_path="$(jq -r '.tool_input.file_path // empty' <<<"$input" 2>/dev/null)" || exit 0

# No target path (should not happen for Edit/Write) — nothing to judge.
[ -n "$file_path" ] || exit 0

# Resolve relative paths against the session's project directory.
case "$file_path" in
/*) ;;
*)
  base="${ZCODE_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$PWD}}"
  file_path="$base/$file_path"
  ;;
esac

# Collapse '..' segments and symlinks so they cannot dodge the prefix check.
resolved="$(realpath -m -- "$file_path" 2>/dev/null)" || resolved="$file_path"

case "$resolved" in
"$CANONICAL" | "$CANONICAL"/*)
  {
    echo "Blocked: ${tool:-edit} targets '$resolved' inside the canonical checkout ($CANONICAL)."
    echo "AGENTS.md requires isolated development: work only in a worktree under"
    echo "/data/agents/workspaces/<agent>/getquick/workbench/<task> on a branch agent/<agent>/<task>."
  } >&2
  exit 2
  ;;
esac

exit 0
