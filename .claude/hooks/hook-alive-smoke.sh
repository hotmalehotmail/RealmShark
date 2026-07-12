#!/usr/bin/env bash
#
# SMOKE TEST — hook-alive probe for the SessionEnd merge-race interlock.
# TEMPORARY: delete this file + the hooks block in .claude/settings.json once the
# real session-complete marker gate is built (or if the probe shows hooks don't
# fire in the cloud Routine). See the conflict-watch/merge-race investigation.
#
# Goal: in ONE remote run, confirm all of:
#   1. a committed .claude/settings.json hook fires in the cloud/web environment,
#   2. SessionEnd (and/or Stop) actually fires there, and
#   3. the session has gh credentials to post to the PR.
# It posts a visible "hook-alive" comment on the current branch's open PR.
#
# BLAST RADIUS — this is a NO-OP everywhere except a remote pipeline/smoke run:
#   Guard 1 (CLAUDE_CODE_REMOTE): unset in the local CLI, so your terminal
#           sessions exit immediately and do nothing.
#   Guard 2 (branch): only claude/* (the pipeline) or a *smoke-hook* branch, so
#           even a personal *web* session on your own branch no-ops.
# The real marker hook will drop the *smoke-hook* clause and keep only claude/*.
#
# Deliberately does NOT `set -e` and always exits 0: Stop is a *blockable* event
# (exit 2 would stop Claude from ending its turn), so this must never fail loudly.

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

# --- Stop fires once per assistant turn; post at most once per session so a
#     multi-turn run doesn't spam. SessionEnd fires once at termination. ---
if [ "$event" = "Stop" ]; then
  sentinel="${TMPDIR:-/tmp}/hook-alive-${session}.stop"
  [ -e "$sentinel" ] && exit 0
  : > "$sentinel" 2>/dev/null
fi

sha="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
pr="$(gh pr list --head "$branch" --state open --json number -q '.[0].number' 2>/dev/null || true)"
[ -z "$pr" ] && exit 0   # no open PR to signal on; nothing to do

body="$(printf '✅ **hook-alive smoke test** — a committed \x60.claude/settings.json\x60 hook fired in this environment.\n\n- event: \x60%s\x60\n- head sha: \x60%s\x60\n- session: \x60%s\x60\n- CLAUDE_CODE_REMOTE: \x60%s\x60\n\n<!-- hook-alive event=%s sha=%s -->' \
  "$event" "$sha" "$session" "${CLAUDE_CODE_REMOTE:-}" "$event" "$sha")"

gh pr comment "$pr" --body "$body" >/dev/null 2>&1 || true
exit 0
