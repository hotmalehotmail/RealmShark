# PAT migration plan — the dev-loop's automation identity

**Status:** implemented on branch `fix/pat-migration` (pending deploy) · **Scope:** `gatekeeper.yml`, `soak-verdict.yml`, `ci.yml`, docs + the `MERGE_PAT` secret. Each PAT-using job now runs a **loud preflight** that fails the run on a missing/expired PAT instead of falling back silently.

## 1 · Why now — two gates, one root cause

The soak loop drives merges and releases through GitHub Actions on the built-in `GITHUB_TOKEN`. Two **independent** GitHub safety mechanisms both key on *who the actor is*, and both bite when that actor is `github-actions[bot]`:

1. **Recursion guard.** Events *caused by* `GITHUB_TOKEN` don't trigger new workflow runs (except `workflow_dispatch`/`repository_dispatch`). So when the gatekeeper auto-merges an agent PR with `GITHUB_TOKEN`, the resulting `pull_request: closed` **never fires** → `post-merge.yml` (which owns `recut-alpha` **and** `cut-latest`) never runs.
   *Symptom:* a soak-fix merges but no fresh alpha is built; a `soak:pass` promotion lands but no "Latest" release and no thaw. (Observed: #47/#49/#53 merged, zero `post-merge` runs.)

2. **"Require approval for external contributors"** (repo → Actions → General). A promotion PR *authored by* `github-actions[bot]` isn't a repo member, so its `ci` + `review` runs are parked in `action_required` — "2 workflows awaiting approval" — and the required checks never report.
   *Symptom:* `soak:pass` opens the promotion PR (e.g. #56) but it sits `BLOCKED`.

Both reduce to the same thing: **`GITHUB_TOKEN` is the wrong identity for actions that must (a) trigger downstream workflows and (b) be trusted like a member.** The sanctioned GitHub answer is a **PAT** (or GitHub App token) owned by a real identity.

> This is not a hack around the platform — the recursion guard is *designed* to be crossed with a PAT/App token when you genuinely need downstream automation. Staying on `GITHUB_TOKEN` is what forces the workarounds.

## 2 · The fix

Use a **fine-grained PAT owned by the repo owner (`hotmalehotmail`)** for exactly the two operations that need a member identity:

- **Creating** the `staging → bridge` promotion PR (`soak-verdict.yml`).
- **Merging** PRs via `gh pr merge --auto` — in `gatekeeper.yml` (agent PRs) and `soak-verdict.yml` (the promotion).

Everything else stays on `GITHUB_TOKEN`. The PAT is applied **per-command** (inline `GH_TOKEN="$PAT" gh …`), so all comments, status stamps, issue ops, and re-fire markers keep their `github-actions[bot]` attribution and the PAT's usage stays narrow.

### Why the owner account, not a dedicated bot
The "external contributors" approval gate exempts the repo **owner**. A *dedicated bot collaborator* is **not** the owner, so it may still trip the gate (needs a one-time approval, which GitHub then remembers). So `hotmalehotmail` is the clean choice. A dedicated bot remains possible later for cleaner attribution — at the cost of that one-time approval **and** updating the marker-comment author filters (§5).

## 3 · What it fixes — all three at once

| Problem today | How the PAT fixes it |
|---|---|
| `post-merge` never fires on auto-merge → no recut / no cut-latest | PAT-armed merge is a real identity → `pull_request: closed` fires → `post-merge.yml` runs as designed |
| Promotion PR parked in `action_required` (approval gate) | PAT-authored PR is from the owner → not an "external contributor" → `ci`/`review` run without approval |
| ci-dispatch workaround (extra code + `actions: write` + `ci.yml` `workflow_dispatch`) | PAT-authored promotion PR triggers `ci` naturally → the whole workaround is deleted |

Keeping the "external contributors" setting **on** stays correct — real fork/stranger PRs on this public repo still need approval before their CI runs. The PAT only exempts *internal* automation.

## 4 · Per-workflow changes

### `soak-verdict.yml` (promote job)
- Promotion `gh pr create` → **PAT** (so `ci` fires naturally).
- **Delete** the `gh workflow run ci.yml --ref staging` dispatch + its `::warning::` fallback.
- **Delete** `actions: write` from the job's `permissions`.
- Promotion `gh pr merge --auto` → **PAT** (so `pull_request: closed` → `cut-latest` fires on merge).
- **Keep** on `github.token`: verdict stamp, comments, issue close, `soak:fail` agent fire.

### `gatekeeper.yml` (gate job)
- The `gh pr merge --squash --auto` arming → **PAT** (so a soak-fix merge fires `recut-alpha`).
- **Keep** on `github.token`: PR list, labels, status reads, comments, conflict-rebase fire.

### `post-merge.yml`
- **Unchanged** — it just works once merges emit real events. (Optional: thaw's `gh pr merge --auto` → PAT for consistency, so thawed merges also behave normally.)

### `ci.yml`
- **Remove** the `workflow_dispatch` trigger (only existed for the promotion-head dispatch). Parity now runs on a genuine promotion `pull_request` where `base = bridge = default` → exempt, the intended semantic.

### Unchanged
`review.yml` (skip-guard is now *more* load-bearing — a PAT-authored promotion PR would otherwise be reviewed and could veto the approved promotion), `fixloop.yml`, `resume.yml`, `release.yml`.

### New secret
`MERGE_PAT` — added **before** the code lands (an empty secret makes the merge/create calls fail).

## 5 · Bot identity — what the PAT does and doesn't change

Three identities exist today:

- **`github-actions[bot]`** — everything on `GITHUB_TOKEN` (comments, statuses, issue ops, merges today, re-fire markers).
- **`claude[bot]`** — the build agent's PRs/commits and the code review (the GitHub App; unrelated to this change).
- **`hotmalehotmail`** — you (kickoff labels, admin merges).

The PAT changes the actor **only** for the PAT-authenticated calls — merges + promotion-PR creation → become the **PAT owner**. Everything else stays as-is.

**Full unification to a single bot voice** is possible but out of scope: it would mean routing *all* `gh` calls through the PAT **and** updating the hardcoded `github-actions[bot]` author filters in `fixloop.yml` / `gatekeeper.yml` / `resume.yml` (they match re-fire markers by comment author). Not recommended now.

## 6 · Test plan

`staging` is currently ahead of `bridge`, so there's a real diff to promote once the PAT path is live.

1. **recut:** a soak-fix merge → `post-merge` `recut-alpha` → fresh alpha built + new soak (the step that silently failed).
2. **promotion:** `soak:pass` → PAT opens the promotion PR → `ci` runs **without** the approval gate → auto-merges → `cut-latest` fires → "Latest" release + thaw + soak close.
3. **regression:** soak-freeze + no-diff promotion paths still behave.

## 7 · Rollout order

1. **You:** create the fine-grained PAT (repo = RealmShark only; permissions = Contents R/W + Pull requests R/W), add it as `MERGE_PAT`, confirm owner = `hotmalehotmail`.
2. **Me:** open `fix/pat-migration` into `staging` (the wiring + deletions).
3. Land on `staging` → **one-time admin promotion to `bridge`** (the new code must be on the default branch to run — same bootstrap move as before). After this the PAT path is self-sustaining.
4. End-to-end test (§6).
5. **Rollback** = revert the PR; the secret can linger unused.

## 8 · Open decisions

- **PAT owner:** `hotmalehotmail` (recommended — clears the approval gate) vs a dedicated bot account (cleaner attribution, one-time approval + filter updates).
- **Go-ahead** to write `fix/pat-migration` once `MERGE_PAT` exists.
