#!/usr/bin/env bash
#
# session-identity — attribute cloud-routine commits to the craig-the-intern-bot GitHub App.
#
# Fires on Claude Code's SessionStart in the build/fix agent's cloud session and points git's
# author/committer identity at the bot's noreply address, so every commit the routine makes is
# attributed to craig-the-intern-bot[bot] on GitHub (GitHub matches the App bot's user id + slug
# in the address for attribution) instead of a human account. This hook supplies only the commit
# IDENTITY (author/committer metadata — free, no auth). The API credential for the agent's OWN
# actions (the PRs it opens, the comments it posts) is minted by the companion
# `session-bot-token.sh` SessionStart hook; the merge/promotion workflows mint their own via
# actions/create-github-app-token. See docs/dev-loop-mechanisms.md §7.2b.
#
# BLAST RADIUS: no-op anywhere but a remote pipeline session.
#   Guard (CLAUDE_CODE_REMOTE): unset in the local CLI -> a maintainer's terminal is untouched,
#   so local commits keep whatever identity the repo/global config already sets. This is the same
#   cloud-only signal the session-done-marker interlock hook uses.
#
# SessionStart is non-blocking; this always exits 0.

# Guard: cloud/web routine only.
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

name="craig-the-intern-bot[bot]"
email="304674093+craig-the-intern-bot[bot]@users.noreply.github.com"

# Set globally so it applies regardless of which worktree the routine ends up committing in.
git config --global user.name  "$name"
git config --global user.email "$email"

# Then also at the repo level — the highest precedence short of a per-command `-c` — so a
# repo-local identity the clone/session setup may have written can't shadow the bot. cd into the
# repo from the SessionStart payload's cwd first (falls back to $PWD), same as session-done-marker.
payload="$(cat 2>/dev/null || true)"
if command -v jq >/dev/null 2>&1; then
  cwd="$(printf '%s' "$payload" | jq -r '.cwd // empty' 2>/dev/null)"
  [ -n "$cwd" ] && cd "$cwd" 2>/dev/null
fi
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git config user.name  "$name"
  git config user.email "$email"
fi

exit 0
