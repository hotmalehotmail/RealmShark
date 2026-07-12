#!/usr/bin/env bash
#
# SMOKE TEST v2 — hook-alive probe for the SessionEnd merge-race interlock.
# TEMPORARY: delete this file + the hooks block in .claude/settings.json once the
# real session-complete marker gate is built.
#
# WHY THIS SHAPE: in the cloud/web env, `gh` is NOT installed and GitHub access is
# meant to go through a scoped MCP server (agent-only) or plain `git` (which here
# routes through a local authenticated proxy, so `git push` works with no token in
# the process). A hook is a *subprocess* — it cannot call MCP tools — so its only
# sanctioned GitHub channel is `git push`. This probe therefore reports by pushing
# a marker ref/tag, and also drops a creds-free local breadcrumb so "did the hook
# fire?" is observable even with zero network.
#
# One fresh remote run confirms, all at once:
#   1. a committed .claude/settings.json hook fires here,
#   2. which event(s) fire (Stop per-turn / SessionEnd at close),
#   3. whether a custom ref and/or a tag is pushable (the escape channel choice).
#
# BLAST RADIUS — NO-OP everywhere except a remote pipeline/smoke run:
#   Guard 1 (CLAUDE_CODE_REMOTE): unset in the local CLI -> your terminal no-ops.
#   Guard 2 (branch): only claude/* or a *smoke-hook* branch.
# Deliberately no `set -e`; always exits 0 (Stop is blockable — never fail loudly).

payload="$(cat 2>/dev/null || true)"   # hook JSON arrives on stdin
jqget() { command -v jq >/dev/null 2>&1 && printf '%s' "$payload" | jq -r "$1" 2>/dev/null; }

event="$(jqget '.hook_event_name // empty')";  [ -z "$event" ]   && event="unknown"
session="$(jqget '.session_id // empty')";     [ -z "$session" ] && session="unknown"
cwd="$(jqget '.cwd // empty')"
[ -n "$cwd" ] && cd "$cwd" 2>/dev/null

# --- Guard 1: cloud/web only. ---
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

# --- Guard 2: pipeline (or this smoke branch) only. ---
branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
case "$branch" in
  claude/*|*smoke-hook*) ;;
  *) exit 0 ;;
esac

# --- Breadcrumb (creds-free): proves the hook fired even if every push fails. ---
ts="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo now)"
root="$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
line="$(printf '%s event=%s branch=%s session=%s remote=%s' "$ts" "$event" "$branch" "$session" "${CLAUDE_CODE_REMOTE:-}")"
printf '%s\n' "$line" >> "$root/.hook-alive.log"            2>/dev/null
printf '%s\n' "$line" >> "${TMPDIR:-/tmp}/hook-alive.log"   2>/dev/null

# --- Stop fires once per assistant turn; mark at most once per session. ---
if [ "$event" = "Stop" ]; then
  sentinel="${TMPDIR:-/tmp}/hook-alive-${session}.stop"
  [ -e "$sentinel" ] && exit 0
  : > "$sentinel" 2>/dev/null
fi

# --- Report via git (the sanctioned channel). Push BOTH a custom ref and a tag;
#     whichever lands on the remote tells us the escape channel for the real gate. ---
sha="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
short="${sha:0:8}"
git push origin "HEAD:refs/session-probe/${event}-${short}" >/dev/null 2>&1 || true
if git tag -f "session-probe-${event}-${short}" >/dev/null 2>&1; then
  git push -f origin "refs/tags/session-probe-${event}-${short}" >/dev/null 2>&1 || true
fi

exit 0
