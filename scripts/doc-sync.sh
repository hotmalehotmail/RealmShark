#!/usr/bin/env bash
#
# doc-sync.sh — background worker fired by .git/hooks/post-commit.
#
# When a commit that touches source code lands, run a headless Claude agent that
# updates any project docs the change made stale, then auto-commits ONLY those
# doc changes. See docs/doc-sync.md for the full rationale.
#
# Invoked as:  doc-sync.sh <commit-sha>
#
# Toggle:  git config doc-sync.enabled false   # disable
#          git config doc-sync.enabled true    # enable (default)
#
# Dry run (validate guards without spending an agent run):
#          DOC_SYNC_DRYRUN=1 scripts/doc-sync.sh <sha>

set -uo pipefail

# A minimal, predictable PATH — git hooks run with a stripped environment.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

SHA="${1:-}"
[ -n "$SHA" ] || exit 0

# Resolve the repo root from this script's own location, NOT from any inherited
# GIT_DIR/GIT_WORK_TREE (the post-commit hook strips those, but be defensive).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || exit 0
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_QUARANTINE_PATH 2>/dev/null || true

MARKER="[doc-sync]"
LOCK="$REPO_ROOT/.git/doc-sync.lock"
LOG="$REPO_ROOT/.git/doc-sync.log"

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG"; }

# ---- On/off switch -----------------------------------------------------------
if [ "$(git config --get doc-sync.enabled 2>/dev/null || echo true)" = "false" ]; then
  exit 0
fi

# ---- Locate the Claude CLI ---------------------------------------------------
CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"
[ -x "$CLAUDE_BIN" ] || CLAUDE_BIN="$HOME/.local/bin/claude"
if [ ! -x "$CLAUDE_BIN" ]; then
  log "skip $SHA: claude CLI not found (looked on PATH and at \$HOME/.local/bin/claude)"
  exit 0
fi

# ---- Recursion guard: never react to our own auto-sync commits ---------------
MSG="$(git log -1 --format='%B' "$SHA" 2>/dev/null || true)"
case "$MSG" in
  *"$MARKER"*) exit 0 ;;
esac

# ---- Skip while a multi-step git operation is in flight ----------------------
for state in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD BISECT_LOG; do
  if [ -e "$REPO_ROOT/.git/$state" ]; then
    log "skip $SHA: $state in progress"
    exit 0
  fi
done

# ---- Only run when the commit actually touched code --------------------------
CHANGED="$(git diff-tree --no-commit-id --name-only -r "$SHA" 2>/dev/null || true)"
if ! printf '%s\n' "$CHANGED" | grep -qE '^(src/|overlay/src/)'; then
  log "skip $SHA: no changes under src/ or overlay/src/"
  exit 0
fi

# ---- Refuse to run on a dirty tree (never touch the user's WIP) --------------
# Ignores untracked files; only tracked modifications would be at risk of being
# swept into the agent's commit.
if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
  log "skip $SHA: working tree has uncommitted tracked changes"
  exit 0
fi

# ---- Single-flight (mkdir is atomic) -----------------------------------------
# Reclaim a lock left behind by a run that was hard-killed (SIGKILL bypasses the
# cleanup trap below); anything older than 30 min is presumed dead.
if [ -d "$LOCK" ] && [ -n "$(find "$LOCK" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then
  rmdir "$LOCK" 2>/dev/null || true
  log "reclaimed stale lock"
fi
if ! mkdir "$LOCK" 2>/dev/null; then
  log "skip $SHA: another doc-sync run holds the lock"
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

SHORT="$(git rev-parse --short "$SHA" 2>/dev/null || echo "$SHA")"

PROMPT="You are a documentation-sync agent running non-interactively from a git post-commit hook in the RealmShark repository. A commit just landed and you must update any project documentation it made inaccurate, then commit only those doc changes.

Commit to review: $SHA

Steps:
1. Run:  git show --stat $SHA   and   git show $SHA   to see exactly what changed.
2. Read CLAUDE.md to learn the project's conventions and which document covers what.
3. Decide, conservatively, whether this commit invalidates anything currently documented under docs/ or in the root CLAUDE.md. Relevant triggers: changed ports, commands, flags, file/class/function names, architecture, the packet wire format, build or release steps, or documented runtime behavior.
4. Make the minimal edits needed for accuracy. Preserve existing wording, structure, and style. Do not rewrite, reformat, reorganize, or improve anything that is still correct. Touch as few lines as possible.

Hard rules:
- You may only edit files under docs/ and the root CLAUDE.md. Never edit source code, tests, build files, or anything under memory/.
- If nothing documented is now stale, make no edits, make no commit, and stop.
- If you did edit docs, stage only the specific doc files you changed, by explicit path (for example: git add docs/architecture.md). Never run 'git add -A' or 'git add .', and never use 'git commit -a'.
- Commit with exactly this subject so the hook recognizes its own commit and avoids an infinite loop:
    git commit -m \"docs: sync docs after $SHORT $MARKER\" -m \"Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\"
  The token $MARKER must appear in the subject verbatim.
- Never push, never amend, never rewrite history."

if [ "${DOC_SYNC_DRYRUN:-0}" = "1" ]; then
  log "DRYRUN $SHA ($SHORT): guards passed; would invoke $CLAUDE_BIN"
  exit 0
fi

log "start $SHA ($SHORT): running doc-sync agent"

# Watchdog: cap the agent run so a hang can't hold the lock indefinitely.
# `timeout` isn't in the macOS base system; use it (or coreutils' gtimeout) if present.
TIMEOUT_BIN="$(command -v timeout 2>/dev/null || command -v gtimeout 2>/dev/null || true)"
RUN=("$CLAUDE_BIN")
[ -n "$TIMEOUT_BIN" ] && RUN=("$TIMEOUT_BIN" 900 "$CLAUDE_BIN")

"${RUN[@]}" -p "$PROMPT" \
  --model sonnet \
  --allowedTools "Read,Grep,Glob,Edit,Write,Bash(git add:*),Bash(git commit:*),Bash(git status:*),Bash(git diff:*),Bash(git show:*),Bash(git log:*)" \
  >>"$LOG" 2>&1
rc=$?

log "done $SHA ($SHORT): doc-sync agent exited ($rc)"
