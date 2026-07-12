#!/usr/bin/env bash
# Rebase FIX-MODE re-fire for a conflicted agent PR (mechanisms §6.5).
#
# The ONE place a conflict re-fires the build agent — called by conflict-watch.yml
# (event-driven: born-DIRTY PRs + staging pushes) and sweep.yml (level-triggered
# backstop). Gatekeeper no longer owns this path; it defers here.
#
# Budget: rebase re-fires count against their OWN budget (MAX_REBASE_ROUNDS,
# `<!-- conflictwatch:refire ... -->` markers), deliberately separate from the
# review-fix loop's MAX_FIX_ROUNDS (`<!-- fixloop:refire -->`): with N parallel
# agent PRs, every sibling merge legitimately re-rebases the others, and that
# churn must not eat the review-failure budget or freeze an innocent PR. For the
# same reason the budget counts only attempts onto the CURRENT staging head —
# each successful rebase leaves one marker for an old base behind, and a PR that
# keeps converging must never accumulate its way into a freeze; the cap measures
# non-convergence (repeated failures against one staging state). The escalation
# guarantee is preserved: a conflict that won't converge still ends in
# `agent:needs-human`.
#
# Dedupe: each marker embeds the staging head SHA the re-fire rebased onto
# (`base=<sha>`). With DEDUP=1 (opened/push/sweep) an existing marker for the
# CURRENT staging head suppresses a duplicate fire — unless it has gone stale
# (> STALE_MIN minutes: the fired agent evidently died without pushing), in
# which case we fire again. DEDUP=0 (synchronize: a fresh head push arrived,
# so the previous attempt has concluded) always allows a fire.
#
# Env: REPO, NUM (PR number), HEAD (head branch), DEDUP (0|1),
#      GH_TOKEN, FIRE_URL, FIRE_TOKEN, MAINTAINER (optional).
# Exit 0 in every no-op case; only an actual /fire failure exits non-zero.

set -euo pipefail

MAX_REBASE_ROUNDS=5 # separate from fixloop's MAX_FIX_ROUNDS (see header)
STALE_MIN=120       # a same-base marker older than this no longer suppresses a re-fire
MARKER_PREFIX='<!-- conflictwatch:refire'

# ---- Skip PRs a human owns. A frozen PR (`agent:needs-human`) is recovered by
#      the maintainer (fix + unlabel) or `agent:retry` (resume.yml) — never by
#      an automated re-fire sneaking past its own escalation. ----
PR_JSON="$(gh pr list --repo "$REPO" --head "$HEAD" --base staging --state open \
             --json number,labels,mergeable,isDraft,isCrossRepository -q '.[0]' 2>/dev/null || true)"
if [ -z "$PR_JSON" ] || [ "$PR_JSON" = "null" ]; then
  echo "#$NUM: no open $HEAD -> staging PR; nothing to do."
  exit 0
fi
if [ "$(printf '%s' "$PR_JSON" | jq -r '.isCrossRepository')" != "false" ]; then
  echo "#$NUM: fork PR — not the loop's to rebase."
  exit 0
fi
if [ "$(printf '%s' "$PR_JSON" | jq -r '.isDraft')" = "true" ]; then
  echo "#$NUM: draft — skipping."
  exit 0
fi
if printf '%s' "$PR_JSON" | jq -e '.labels[]? | select(.name == "agent:needs-human")' >/dev/null; then
  echo "#$NUM: frozen (agent:needs-human) — a human owns it; skipping."
  exit 0
fi

# ---- Poll mergeability past UNKNOWN (GitHub computes it async, and the events
#      we fire on are exactly when it's being recomputed). ----
MERGEABLE="UNKNOWN"
for _ in 1 2 3 4 5 6; do
  MERGEABLE="$(gh pr view "$NUM" --repo "$REPO" --json mergeable -q '.mergeable' 2>/dev/null || echo UNKNOWN)"
  [ "$MERGEABLE" != "UNKNOWN" ] && break
  sleep 5
done
if [ "$MERGEABLE" != "CONFLICTING" ]; then
  echo "#$NUM: mergeable='$MERGEABLE' — no conflict to resolve."
  exit 0
fi

# ---- Soak freeze (§9.5): while a soak is open, don't churn held PRs' rebase
#      budgets on every soak-fix merge — they can't merge until the thaw anyway,
#      and sweep re-fires any still-DIRTY PR once the soak closes. Soak-fix PRs
#      (the `soak-fix` label; the soak:fail brief tells the agent to apply it)
#      are exempt: THEY must converge during the soak. ----
if [ "$(gh issue list --repo "$REPO" --state open --label soak --json number -q 'length' 2>/dev/null || echo 0)" -gt 0 ]; then
  if ! printf '%s' "$PR_JSON" | jq -e '.labels[]? | select(.name == "soak-fix")' >/dev/null; then
    echo "#$NUM: conflicted but a soak is open and this isn't a soak-fix — deferring (sweep re-fires after the thaw)."
    exit 0
  fi
fi

BASE_SHA="$(gh api "repos/$REPO/git/ref/heads/staging" -q '.object.sha')"

# ---- Markers: budget + dedupe. ----
COMMENTS="$(gh api --paginate "repos/$REPO/issues/$NUM/comments" \
              -q ".[] | select(.user.login==\"github-actions[bot]\" and (.body|contains(\"$MARKER_PREFIX\"))) | [.created_at, .body] | @base64" \
              2>/dev/null || true)"
# PRIOR counts only markers for the CURRENT staging head (see the budget note in
# the header): attempts onto superseded bases were legitimate churn, not failures.
PRIOR=0
SAME_BASE_AT=""
for ROW in $COMMENTS; do
  DECODED="$(printf '%s' "$ROW" | base64 -d)"
  if printf '%s' "$DECODED" | grep -q "base=$BASE_SHA"; then
    PRIOR=$((PRIOR + 1))
    SAME_BASE_AT="$(printf '%s' "$DECODED" | jq -r '.[0]' 2>/dev/null || true)"
  fi
done

if [ "${DEDUP:-1}" = "1" ] && [ -n "$SAME_BASE_AT" ]; then
  AGE_MIN=$(( ( $(date -u +%s) - $(date -u -d "$SAME_BASE_AT" +%s 2>/dev/null || date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$SAME_BASE_AT" +%s) ) / 60 ))
  if [ "$AGE_MIN" -lt "$STALE_MIN" ]; then
    echo "#$NUM: already re-fired for staging@${BASE_SHA:0:9} ${AGE_MIN}m ago — waiting on that agent."
    exit 0
  fi
  echo "#$NUM: prior re-fire for staging@${BASE_SHA:0:9} is stale (${AGE_MIN}m) — firing again."
fi

ATTEMPT=$((PRIOR + 1))
if [ "$PRIOR" -ge "$MAX_REBASE_ROUNDS" ]; then
  echo "#$NUM: still conflicted after $PRIOR rebase attempt(s) onto staging@${BASE_SHA:0:9} — escalating."
  gh label create "agent:needs-human" --repo "$REPO" --color "B60205" \
    --description "Agent loop stalled — needs a maintainer" --force >/dev/null 2>&1 || true
  gh pr edit "$NUM" --repo "$REPO" --add-label "agent:needs-human" >/dev/null 2>&1 || true
  MENTION=""; [ -n "${MAINTAINER:-}" ] && MENTION="@$MAINTAINER "
  gh pr comment "$NUM" --repo "$REPO" --body "${MENTION}🛑 **Merge conflict couldn't be auto-resolved** in $MAX_REBASE_ROUNDS rebase attempt(s) onto the current \`staging\` head (a budget separate from review-fix rounds; it resets when \`staging\` moves). This PR needs a manual rebase (\`git merge origin/staging\`, resolve, push), then remove \`agent:needs-human\` (or apply \`agent:retry\` for a fresh budget)."
  exit 0
fi

# ---- Under budget: re-fire the builder in FIX MODE with the rebase instruction. ----
if [ -z "${FIRE_URL:-}" ] || [ -z "${FIRE_TOKEN:-}" ]; then
  echo "::warning::#$NUM conflicts but ROUTINE_FIRE_* secrets are unset — cannot auto-rebase."
  gh pr comment "$NUM" --repo "$REPO" --body "⚙️ This PR conflicts with \`staging\`, but the loop can't re-fire the agent to rebase (missing ROUTINE_FIRE_* secrets). Rebase manually." || true
  exit 0
fi
TEXT="$(printf 'FIX MODE. Repository %s. PR #%s, head branch `%s`, base `staging`.\nThis PR CONFLICTS with `staging`. Check out `%s`, merge `origin/staging` into it, resolve the conflicts, and PUSH to `%s` — do NOT open a new PR. Do not change anything beyond what the conflict resolution requires.' \
  "$REPO" "$NUM" "$HEAD" "$HEAD" "$HEAD")"
jq -nc --arg t "$TEXT" '{text: $t}' > /tmp/fire.json
RESP="$(curl -sS -X POST "$FIRE_URL" \
  -H "Authorization: Bearer $FIRE_TOKEN" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: experimental-cc-routine-2026-04-01" \
  -H "Content-Type: application/json" \
  --data @/tmp/fire.json || true)"
URL="$(printf '%s' "$RESP" | jq -r '.claude_code_session_url // empty' 2>/dev/null || true)"
if [ -n "$URL" ]; then
  gh pr comment "$NUM" --repo "$REPO" --body "🔀 Conflicts with \`staging\` — re-fired the agent in **FIX MODE** to rebase onto \`staging@${BASE_SHA:0:9}\` (rebase attempt $ATTEMPT/$MAX_REBASE_ROUNDS — separate from review-fix rounds). [Watch the session]($URL). $MARKER_PREFIX base=$BASE_SHA -->"
else
  gh pr comment "$NUM" --repo "$REPO" --body "$(printf '⚠️ Tried to auto-rebase the conflict but the FIX MODE re-fire failed. Routine response:\n```\n%s\n```' "$RESP")" || true
  exit 1
fi
