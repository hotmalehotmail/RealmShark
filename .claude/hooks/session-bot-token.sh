#!/usr/bin/env bash
#
# session-bot-token — give the cloud-routine session the craig-the-intern-bot API credential,
# so the PRs it OPENS and the comments it POSTS are attributed to craig-the-intern-bot[bot]
# instead of the maintainer's account.
#
# The companion `session-identity.sh` only sets git's commit *metadata* (author/committer) — free,
# no auth. But opening a PR and posting comments are authenticated GitHub API calls, attributed to
# whoever the TOKEN authenticates as; the routine's ambient credential is the maintainer, so those
# still read as a human. This hook closes that gap by minting a short-lived App installation token
# (the same craig-the-intern-bot App the merge workflows use) at session start and wiring it into
# git + gh, mirroring how gatekeeper.yml / sweep.yml / soak-verdict.yml mint it in-job.
# See docs/dev-loop-mechanisms.md §7.2b.
#
# FAIL-SAFE: every failure path exits 0 WITHOUT touching git/gh config, so a missing secret, absent
# tool, or blocked API leaves the session exactly as it was (PRs as the maintainer) rather than
# half-configured. Merging this can't break the routine; it's inert until the secrets are present.
#
# BLAST RADIUS: no-op anywhere but a remote pipeline session (CLAUDE_CODE_REMOTE guard), same as
# session-identity.sh — a maintainer's local terminal is never re-authed.
#
# REQUIRES (all cloud-side, none committed): routine env secrets BOT_APP_ID + BOT_APP_PRIVATE_KEY
# (PEM), and openssl + curl + jq in the routine image. The App needs Contents + Pull requests +
# Issues: read/write (same install the gatekeeper relies on).
#
# CAVEAT (gh only): a GH_TOKEN/GITHUB_TOKEN env var set by the platform OUT-RANKS gh's stored
# credentials, so if the routine injects the maintainer's token that way, `gh` keeps using it for
# PR/comment despite the `gh auth login` below. git push is unaffected (the insteadOf token wins).
# The per-command fallback for that case is the token file written at the end (see the routine
# prompt). No env export here can fix it — a hook subprocess can't mutate the session's env.
#
# SessionStart is non-blocking; this always exits 0.

set -u

# ---- Guard: cloud/web routine only. ------------------------------------------------------------
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

note() { printf 'session-bot-token: %s\n' "$1" >&2; }

# ---- Preconditions. Any missing => no-op (fall back to the ambient credential). ----------------
: "${BOT_APP_ID:=}"
: "${BOT_APP_PRIVATE_KEY:=}"
if [ -z "$BOT_APP_ID" ] || [ -z "$BOT_APP_PRIVATE_KEY" ]; then
  note "BOT_APP_ID / BOT_APP_PRIVATE_KEY not set — leaving the ambient credential in place (no-op)."
  exit 0
fi
for tool in openssl curl jq; do
  command -v "$tool" >/dev/null 2>&1 || { note "$tool not available — cannot mint; leaving auth untouched."; exit 0; }
done

# ---- Resolve owner/repo (for the installation lookup). -----------------------------------------
slug="${GITHUB_REPOSITORY:-}"
if [ -z "$slug" ]; then
  # Move to the repo from the SessionStart payload's cwd (same as session-identity.sh), then read origin.
  payload="$(cat 2>/dev/null || true)"
  cwd="$(printf '%s' "$payload" | jq -r '.cwd // empty' 2>/dev/null || true)"
  [ -n "$cwd" ] && cd "$cwd" 2>/dev/null || true
  origin="$(git config --get remote.origin.url 2>/dev/null || true)"
  slug="$(printf '%s' "$origin" | sed -E 's#^.*github\.com[:/]+##; s#\.git$##')"
fi
[ -n "$slug" ] || { note "could not resolve owner/repo — no-op."; exit 0; }

# ---- Mint: sign an RS256 App JWT, then exchange it for an installation token. -------------------
# Standard GitHub App flow (docs: "Generating an installation access token"): base64url header +
# claims, RS256-sign with the App key, then POST /app/installations/{id}/access_tokens.
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

keyfile="$(mktemp)"; tokfile_cleanup() { rm -f "$keyfile"; }; trap tokfile_cleanup EXIT
# Accept a PEM stored either with real newlines or with literal "\n" escapes (common in secret stores).
printf '%s' "$BOT_APP_PRIVATE_KEY" | sed 's/\\n/\n/g' > "$keyfile"

now="$(date +%s)"
header="$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)"
claims="$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' "$((now - 60))" "$((now + 540))" "$BOT_APP_ID" | b64url)"
signature="$(printf '%s.%s' "$header" "$claims" | openssl dgst -sha256 -sign "$keyfile" -binary 2>/dev/null | b64url)" || true
[ -n "$signature" ] || { note "JWT signing failed (bad BOT_APP_PRIVATE_KEY?) — no-op."; exit 0; }
jwt="$header.$claims.$signature"

api() { curl -fsS -H "Authorization: Bearer $1" -H "Accept: application/vnd.github+json" \
             -H "X-GitHub-Api-Version: 2022-11-28" "${@:2}"; }

install_id="$(api "$jwt" "https://api.github.com/repos/$slug/installation" 2>/dev/null | jq -r '.id // empty' || true)"
[ -n "$install_id" ] || { note "installation lookup failed for $slug — no-op."; exit 0; }

token="$(api "$jwt" -X POST "https://api.github.com/app/installations/$install_id/access_tokens" 2>/dev/null | jq -r '.token // empty' || true)"
[ -n "$token" ] || { note "installation-token exchange failed — no-op."; exit 0; }

# ---- Wire the token in. Only now that we have a real token do we touch any config. --------------
# git push: rewrite github.com https to carry the token inline. git does NOT consult GH_TOKEN, so
# this makes pushes act as the bot regardless of any ambient token. (Token is short-lived ~1h.)
git config --global "url.https://x-access-token:${token}@github.com/.insteadOf" "https://github.com/"

# gh (PR open + comments): store the token as gh's credential. NOTE the caveat above — an ambient
# GH_TOKEN out-ranks this. Best-effort; failures are non-fatal.
printf '%s' "$token" | gh auth login --with-token >/dev/null 2>&1 || note "gh auth login failed (older gh, or ambient GH_TOKEN) — see token file."
gh auth setup-git >/dev/null 2>&1 || true

# Per-command fallback for the ambient-GH_TOKEN case: the routine prompt can prefix GitHub API
# calls with this token (GH_TOKEN="$(cat "$BOT_GH_TOKEN_FILE")" gh ...) to force the bot identity.
tokdir="${XDG_CACHE_HOME:-$HOME/.cache}"
mkdir -p "$tokdir" 2>/dev/null || true
umask 077
printf '%s' "$token" > "$tokdir/craig-bot-gh-token" 2>/dev/null \
  && note "minted craig-the-intern-bot installation token (git wired; gh best-effort; file at $tokdir/craig-bot-gh-token)."

exit 0
