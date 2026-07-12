#!/usr/bin/env bash
#
# session-done marker — the merge-race interlock (docs/dev-loop-mechanisms.md §"session
# interlock"). Fires on Claude Code's SessionEnd, i.e. when the build/fix agent's cloud
# session has actually TERMINATED — not when the model *thinks* it is done. It records
# "the session that authored this head commit has ended" by pushing a marker branch.
#
# WHY: the gatekeeper arms auto-merge the instant ci + review-verdict go green, which is
# decoupled from whether the authoring session has finished. In PR #115 the fix agent was
# still running when review passed; auto-merge fired, then 54s later the agent pushed a
# real correction to the already-merged branch, stranding it. The gatekeeper now refuses
# to arm until a marker for the PR's current head exists — so a still-running session can
# no longer be merged out from under.
#
# CHANNEL: in the cloud env `gh` is absent and GitHub goes through a scoped MCP server
# (agent-only — a hook subprocess cannot use it) or a local git proxy. The proxy accepts
# ONLY `refs/heads/*` pushes (custom refs and tags -> HTTP 403), so the marker is a branch
# `refs/heads/session-done/<head-sha>` pointing at the head commit. The gatekeeper reads it
# with `git ls-remote`; sweep GCs stale ones.
#
# BLAST RADIUS: no-op everywhere except a remote pipeline session.
#   Guard 1 (CLAUDE_CODE_REMOTE): unset in the local CLI -> a maintainer's terminal no-ops.
#   Guard 2 (branch): only claude/* (pipeline PR branches).
# SessionEnd is non-blockable; this always exits 0.

# Guard 1: cloud/web only.
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

# Resolve the repo from the SessionEnd payload's cwd (falls back to $PWD), so `git` runs
# against the right worktree regardless of where the hook is invoked from.
payload="$(cat 2>/dev/null || true)"
if command -v jq >/dev/null 2>&1; then
  cwd="$(printf '%s' "$payload" | jq -r '.cwd // empty' 2>/dev/null)"
  [ -n "$cwd" ] && cd "$cwd" 2>/dev/null
fi

# Guard 2: pipeline branches only.
branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
case "$branch" in
  claude/*) ;;
  *) exit 0 ;;
esac

sha="$(git rev-parse HEAD 2>/dev/null || echo '')"
[ -n "$sha" ] || exit 0

# Push the marker branch. Idempotent: if the session ended on a head that already has a
# marker (e.g. a decline-only fix round left the head unchanged), the push is a no-op and
# the gatekeeper's existing marker still stands. `|| true` — never fail session teardown.
git push origin "$sha:refs/heads/session-done/$sha" >/dev/null 2>&1 || true

exit 0
