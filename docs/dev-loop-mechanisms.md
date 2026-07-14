# Autonomous dev loop — mechanisms & enforcement

Companion to [dev-loop-full-spec.html](dev-loop-full-spec.html). That doc is the
*design intent*; this one is the **precise, per-step mechanism ledger**: for every
stage of the pipeline it names exactly **what drives it** (what causes it to run)
and **what enforces it** (what guarantees its rule can't be skipped), states
whether it is **built**, and — where it is not — specifies exactly what must be
built, down to triggers, tokens, state, and the human-escalation flow.

Verified against the repo state on 2026-07-10 (default branch `bridge`, integration
branch `staging`).

## How to read this

Every stage has three labels:

- **Drives** — the concrete trigger/actor that makes the step execute. An event
  (`issues: labeled`), a webhook, a push, an agent action.
- **Enforces** — the concrete gate that makes the step's guarantee hold and can't
  be bypassed. A branch-protection rule, a required status check, a token scope, a
  repo permission, a workflow-validation guard.
- **Status** — 🟢 Built · 🟡 Partial · 🔴 Unbuilt.

"Drive" and "enforce" are deliberately separated because most gaps here are a
step that *runs* (driven) but is *not gated* (unenforced), or vice-versa.

## Status at a glance

| # | Stage | Drives | Enforces | Status |
|---|-------|--------|----------|--------|
| 1 | Issue + label kickoff | `issues: labeled` → `implement.yml` | maintainer-only labels; `/fire` secrets | 🟢 |
| 2 | Routine fire → cloud session | `implement.yml` `curl /fire` | per-routine bearer token; Auto-Mode allowlist | 🟢 |
| 3 | Build agent → branch + PR | routine session (Opus 4.8) | GitHub App push scope; `claude/*` branch convention | 🟢 |
| 4 | CI ground-truth checks | `pull_request` → `ci.yml` | branch protection required checks | 🟢 |
| 5 | Independent review | `pull_request` → `review.yml` | workflow-validation guard | 🟢 verdict live |
| 6 | Fix loop (review → re-fire builder, capped) | `workflow_run` of `review` → `fixloop.yml`; `agent:retry` → `resume.yml`; conflict → `conflict-watch.yml` (+ sweep backstop) rebase | `review-verdict` status; `MAX_FIX_ROUNDS` (review) + `MAX_REBASE_ROUNDS` (conflicts); `agent:needs-human` freeze | 🟡 re-fire + escalate + resume + conflict-rebase built; live-verify pending |
| 7 | Gatekeeper auto-merge | `workflow_run` → arm auto-merge | native auto-merge + required checks | 🟢 verified (#19) |
| 8 | Release (ship button) | `workflow_dispatch` → `release.yml` | manual-only dispatch | 🟢 (captain notes + auto-bump built) |
| 9 | Alpha soak → promote or fix | `soak:pass`/`soak:fail` labels; auto-cut on staging merge; latest-on-promotion | maintainer-only labels; `soak:pass` = stamped `review-verdict` on the promotion PR | 🟡 built pending deploy (PRs #41 #42) — fix-forward, auto-cut, labels, PR-based promote (no token) |
| — | Branch protection | — | required checks (+ push restriction) | 🟢 verdict required (push restrict N/A on user repo) |
| — | Workflow-parity guard | `ci` job on each PR | required check (both branches) | 🟢 verified |

---

## 1 · Issue + label kickoff

**Drives.** A maintainer applies the `agent:build` or `agent:fix` label to an issue.
`.github/workflows/implement.yml` runs `on: issues: [labeled]`, gated by
`if: github.event.label.name == 'agent:build' || github.event.label.name == 'agent:fix'`.
Opening an issue alone does nothing — only the label event fires the job.

**Enforces.** Two independent gates:
1. **Label application is maintainer-only.** On a public repo, applying a label
   requires write (triage) permission, so a stranger opening an issue cannot start
   an agent. This *is* the security boundary for the whole loop.
2. **The `/fire` call requires secrets.** `implement.yml` no-ops with a hint comment
   if `ROUTINE_FIRE_URL` / `ROUTINE_FIRE_TOKEN` are unset, so a fork without secrets
   can't fire anything.

**Status.** 🟢 Built and verified (issue #10). Untrusted issue fields are passed as
env vars, never interpolated into the shell.

**Watch-out (documented, not a gap).** The bearer token and URL are secrets; a
trailing newline in either silently 400s the `/fire` call with a misleading
"could not parse request body as JSON". Set them with `printf %s`, never `echo`.

**Issue label lifecycle.** The workflows keep two status labels on the issue in sync
with agent progress (the trigger labels `agent:build`/`agent:fix` stay put):

- `agent:in-progress` — added by `implement.yml` once the routine fires successfully
  (only in the success branch — a failed dispatch must not read "working").
- `agent:completed` — added (and `agent:in-progress` removed) by `post-merge.yml`'s
  `label-completed` job when a PR that closes the issue merges into `staging`. This is
  needed because GitHub's `Closes #N` auto-close only fires on the **default** branch
  (`bridge`), so a `staging` merge leaves the issue open — the label is the "agent
  finished, now soaking" signal for that window. Only issues that carry
  `agent:in-progress` are transitioned, so a human-closed issue isn't stamped.
- `agent:needs-human` — on escalation (`fixloop.yml`, fix budget spent) the same
  label the PR gets is mirrored onto the issue, and `agent:in-progress` removed, so a
  stalled issue stops reading as "agent working".

---

## 2 · Routine fire → cloud session

**Drives.** `implement.yml` `POST`s to the routine's `/fire` endpoint
(`https://api.anthropic.com/v1/claude_code/routines/<trig_id>/fire`, body
`{"text": "<issue as work item>"}`, headers `anthropic-version: 2023-06-01` +
`anthropic-beta: experimental-cc-routine-2026-04-01`). A `200` returns
`claude_code_session_url`, which the workflow comments back on the issue.

**Enforces.** The per-routine bearer token (`sk-ant-oat01-…`) scopes the call to
exactly one routine — a leaked token can start that routine and nothing else.
Inside the session, Auto Mode's tool allowlist bounds what the agent may do
unattended.

**Status.** 🟢 Built. Setup is documented in
[build-agent-routine.md](build-agent-routine.md).

---

## 3 · Build agent → branch + PR

**Drives.** The cloud session (Claude Code, Opus 4.8) runs the routine prompt:
read `CLAUDE.md`, branch `claude/<slug>` off `origin/staging`, implement the issue,
self-check (typecheck/lint/compile), open a PR into `staging` with a Conventional
Commits title, `Closes #N`, and an "Assumptions" block.

**Enforces.** The agent commits under the Claude GitHub App identity with push
scope to the repo. The `claude/*` head-branch prefix is the convention every
downstream gate keys on ("is this a pipeline PR?"). The routine prompt forbids
touching `bridge` directly, `.github/workflows/`, or publishing releases.

**Status.** 🟢 Built and verified (PR #19, `claude/dps-formatter → staging`).

**To-build for the fix loop (see §6).** The prompt currently only knows how to
*open a new* branch/PR. It needs a second mode — "operate on an existing branch" —
so the same agent can push fixes to the PR under review. Specified in §6.

---

## 4 · CI ground-truth checks

**Drives.** `.github/workflows/ci.yml` runs `on: pull_request: branches: [staging, bridge]`.
Two jobs: `overlay — typecheck + lint` (Node 22, `npm ci --ignore-scripts`,
`npm run typecheck`, `npm run lint`) and `bridge — compile + fat jar`
(`gradle bridgeJar`, Gradle pinned 7.4.2 via `gradle/actions/setup-gradle@v4`).

**Enforces.** Branch protection on `staging` and `bridge` lists both job names as
**required status checks** (verified: contexts `overlay — typecheck + lint` and
`bridge — compile + fat jar`). A PR cannot merge until both are green.

**Status.** 🟢 Built. **PR #18** landed the JUnit DPS test module and added a `gradle
test` step to the `bridge` job. It runs inside the existing `bridge — compile + fat
jar` context, so the required-check list is unchanged — the ground-truth gate now
includes behavioral tests, on both `staging` and `bridge`.

---

## 5 · Independent review

**Drives.** `.github/workflows/review.yml` runs `on: pull_request: [opened, synchronize,
reopened]` for base `staging`/`bridge`, in three deterministic phases (the **judge /
scribe split**, audit H2/H3):
1. **stage** — plain bash (`github.token`, read-only `gh`) writes the diff + the linked
   issue to files, and computes the verdict facts that must NOT be left to the model:
   is this a `claude/*` agent branch, does it touch `.github/`, does it declare a
   `Closes #N`.
2. **judge** — `anthropics/claude-code-action@v1` (Opus 4.8, `CLAUDE_CODE_OAUTH_TOKEN`)
   with **`--allowedTools Read,Grep,Glob,Write` — no Bash, no gh**. It reads the staged
   inputs + the repo and WRITES its findings to `review-inputs/verdict.json`. With no
   shell it physically cannot post a review or a status, so untrusted diff content has
   **no path to the gate** (this replaces the old design where the reviewer posted its
   own verdict via `Bash(gh:*)` — the credential-holding-judge risk in audit H2).
3. **scribe** — plain bash. Computes the verdict as a deterministic function of the
   judge's findings + the stage facts (any `high`/`critical` finding, an agent PR
   touching `.github/`, an agent PR with no issue link, or unmet acceptance criteria
   ⇒ fail), posts the review (`POST /pulls/{n}/reviews`, with a single-comment 422
   fallback), and posts the `review-verdict` status. **Soak-fix PRs are exempt from the
   issue-link requirement** (detected by the `soak-fix` label or an "Addresses soak #N"
   body reference, the same signals the §9.5 gatekeeper freeze-exemption uses): they
   close no discrete issue — the soak issue is loop-managed (superseded on re-cut, closed
   on promotion) — so requiring a `Closes #N` would wrongly auto-fail every soak-fix. The
   `.github/` tripwire still applies to them.

**Enforces.** Two layers. (1) `claude-code-action`'s **workflow-validation guard**: the
judge runs only if the executing `review.yml` is **byte-identical to the copy on the
default branch (`bridge`)** — a PR can't rewrite the reviewer to rubber-stamp itself.
(This is also why a stale `review.yml` on `staging` silently skipped reviews until the
branches were synced, and why a change to `review.yml` is admin-merged to `bridge`
first.) (2) The **judge/scribe split**: because the model that reads untrusted content
has no shell and no gate credential, a prompt injection can at most produce wrong
*findings* (model misjudgment), never a forged pass — the pass/fail is derived
deterministically from those findings by the scribe, and the security gates (the
`.github/` tripwire, the issue-link requirement) are computed from the diff, not the
model.

**Status.** 🟢 Built (verified live on PR #22: `review-verdict = success`). Both
gaps that made this Partial are now closed:

1. **Machine-readable verdict — done.** The prompt now chooses `REQUEST_CHANGES`
   (any `high`/`critical` finding) or `APPROVE`, and publishes a `review-verdict`
   commit status (success/failure) on the PR head SHA. Downstream can gate on it;
   the fix loop has its "changes requested" signal.
2. **No longer green-on-skip.** The verdict lives in a *separate* `review-verdict`
   status, not the job's exit code. A validation-skip posts no status, so a required
   `review-verdict` check fails closed instead of reading "approved".

**Built in PR #21** (merged to `staging` + promoted to `bridge` in lockstep; verified
by the `review-verdict = success` status posted on PR #22). The review verdict is the
linchpin for §6 and §7. How it works:
- **Decision rule (in the prompt).** If any finding is severity `high` or `critical`
  → `event: REQUEST_CHANGES`; else → `event: COMMENT` (low/medium findings still go in
  the body as non-blocking notes). **Not `APPROVE`** — the GitHub Actions bot *cannot*
  submit APPROVE reviews (the call fails and the summary is dropped; found live on
  #22/#19 in PR #23). We gate on the status, not an approval, so a pass posts a
  `COMMENT` review **plus** `review-verdict = success`.
- **Explicit status check (the gate).** As a final step, post a commit status on the
  PR head SHA: `gh api -X POST repos/{repo}/statuses/{sha} -f state=success|failure
  -f context=review-verdict -f description=…`. `success` when the review event is
  `APPROVE`, `failure` when `REQUEST_CHANGES`.
- **Fail-closed by construction.** If the review *skips* or errors, **no
  `review-verdict` status is ever posted**, so the check stays *pending/absent* and
  any branch-protection rule requiring it **blocks the merge**. This is the correct
  inverse of today's "green on skip".
- **Remaining (step 3):** add `review-verdict` to branch protection's required checks
  so a failing verdict actually *blocks* a merge (today it posts but nothing gates
  on it — see Branch protection).

---

## 6 · Fix loop — review requests changes → re-fire the builder (capped)

**Status.** 🟡 Partial — the full loop (converge + escalate + resume) is built; live
verification is not. **Built:** `.github/workflows/fixloop.yml` (`on: workflow_run` of
`review` → read `review-verdict` → round-count → re-fire in FIX MODE or escalate, per
§6.1/§6.2), `.github/workflows/resume.yml` (`agent:retry` label → reset both budgets →
re-fire, §6.3) + the `agent:retry` repo label, the FIX-MODE branch of the routine
prompt ([build-agent-routine.md](build-agent-routine.md)), and the conflict-rebase
path (§6.5 — `conflict-watch.yml` + the sweep backstop, sharing
`.github/scripts/rebase-refire.sh` and its own `MAX_REBASE_ROUNDS` budget).
**Still to build:** an end-to-end live verification
(the loop hasn't yet run against a real change-request). Until the routine's live
prompt is re-pasted with the FIX-MODE block, a re-fire is a no-op. **Activation:**
`fixloop.yml` fires only from the default branch (`workflow_run`), so both workflows
must reach `bridge` before the loop is live.

**Depends on:** §5's `REQUEST_CHANGES` verdict (done), and §3's "operate on an existing
branch" agent mode (done — the FIX-MODE prompt branch).

### 6.1 Normal (converging) path — exactly what happens

**Trigger (Option B — `workflow_run`, chosen deliberately).** A new workflow
`.github/workflows/fixloop.yml` fires when the **review workflow completes**, then
reads the verdict:
```yaml
on:
  workflow_run:
    workflows: [review]
    types: [completed]
```
The job pulls the PR's head branch + SHA from the `workflow_run` payload, ignores
anything whose head isn't `claude/*`, reads the `review-verdict` commit status on
that SHA, and acts **only if it is `failure`** (a change-request); a `success`
verdict is a no-op (the gatekeeper handles it).

> **Why `workflow_run`, not `pull_request_review`?** The obvious trigger would be
> the reviewer's `REQUEST_CHANGES` submission. But the reviewer posts that with the
> built-in `GITHUB_TOKEN`, and **GitHub's recursion guard suppresses workflow
> triggers for events caused by `GITHUB_TOKEN`** — so a `pull_request_review` trigger
> would silently never fire. `workflow_run` is GitHub's designated "chain off another
> workflow" event and fires regardless of which token produced the checks. This
> choice means **no non-default token is needed anywhere in the loop** (see §6.4).

**Round counting (stateless, from the API — no fragile label state).** The job
computes:
```
prior_refires = count of fixloop's own <!-- fixloop:refire --> re-fire comments on this PR
attempt       = prior_refires + 1
```
via `GET /repos/{repo}/issues/{n}/comments`, filtered to `github-actions[bot]` and the
hidden marker. **It counts fixloop's own re-fire comments, not reviews** — because
`review.yml` posts its verdict via a plain PR comment (no review object) when its
`POST /reviews` call 422s (an inline comment on a line outside the diff rejects the
whole review), while still posting `review-verdict = failure`. A review-based count
would then stay `0` and re-fire forever; a self-authored marker is posted exactly once
per successful attempt, so it increments every round regardless of how the review was
delivered — and is inherently bounded. A label `loop:<attempt>` is set for human
visibility (not read back). *(As implemented in `fixloop.yml`; the earlier
review-dismissal design below is superseded by this — see the resume note in §6.3.)*

**Cap.** `MAX_FIX_ROUNDS = 3`.
- If `rounds <= 3` → **re-fire** (this is automated fix attempt #`rounds`).
- If `rounds >= 4` → **escalate** (the 3 automated attempts are spent). See §6.2.

**Re-fire — exact behavior.** The job `curl`s the same routine `/fire` endpoint
used at kickoff, but with a **FIX-MODE work item**:
```
FIX MODE. Repository {repo}. PR #{n}, head branch `{head.ref}`, base `staging`.
A reviewer requested changes. Check out `{head.ref}`, read the full PR conversation
(review comments AND any maintainer comments) for guidance, address every unresolved
review comment below, and PUSH your fixes to `{head.ref}` — do NOT open a new PR.
If you believe a comment is wrong, reply to that review comment explaining why
instead of changing code.

Unresolved review comments:
{verbatim body + inline comments from GET .../reviews and .../comments}
```
The routine prompt (build-agent-routine.md) gains a branch: *if the input starts
with `FIX MODE`, operate on the named existing branch and push to it; never open a
new PR.* The agent's push emits a `synchronize` event → **§4 CI and §5 review
re-run automatically** on the new commit → a fresh `review-verdict`.

**Convergence.** As soon as a review round returns a passing verdict (`review-verdict
= success`), §7 (gatekeeper) merges the PR. The `loop:*` label is cleared on merge.
So the normal loop is: request-changes → re-fire → push → re-review → … → pass →
auto-merge, bounded at 3 automated attempts.

### 6.2 Escalation — exactly how it stops and how you are flagged

When `rounds >= 4`, `fixloop.yml` does **not** re-fire. Instead, in one job, using
the built-in `GITHUB_TOKEN` (with `issues: write` + `pull-requests: write` — these
escalation actions don't need to trigger anything downstream, so no special token):

1. **Stops the loop.** Because it does not re-fire and does not push, no
   `synchronize` occurs, so neither CI nor review re-run. The PR sits at its last
   `CHANGES_REQUESTED` verdict → `review-verdict = failure` → **not mergeable**
   (once that check is required). The loop is halted by *inaction*, not a kill
   switch — there is nothing left running to stop.
2. **Labels it.** Adds `agent:needs-human`, removes `loop:*`.
3. **Disables any pending auto-merge.** `gh pr merge {n} --disable-auto` (harmless
   if none was queued), so it cannot merge behind your back while you look.
4. **Flags you — three notifications, all native GitHub:**
   - Posts a PR comment `@`-mentioning the maintainer handle (configured as a repo
     variable `MAINTAINER_HANDLE`, e.g. `@hotmalehotmail`). The comment contains:
     the latest reviewer summary, a bulleted list of the still-unresolved findings,
     and links to each of the 3 attempt reviews (an audit trail of what was tried).
   - Assigns the PR to that maintainer (`gh pr edit {n} --add-assignee`).
   - The `@`-mention **and** the assignment each generate a GitHub notification →
     email + web inbox + mobile push (per your notification settings). That is
     exactly how you learn it's stuck; you do not have to be watching.
5. The job exits `0` (escalation is a normal outcome, not a CI failure).

### 6.3 Your input and resume — exactly what you do and what happens next

You have two supported ways to unblock, and precisely one thing happens in each:

**(a) Steer the agent (stay hands-off on code).** You apply the **`agent:retry`**
label to the PR — optionally after dropping a normal comment with your steer.
`.github/workflows/resume.yml` (**built**) runs `on: pull_request: types: [labeled]`
with `if: github.event.label.name == 'agent:retry'`, and:
- **No auth filter needed** — applying a label requires write/triage permission, so
  GitHub already guarantees the actor is a maintainer. This is the *same* gate as
  kickoff (§1), so the resume path inherits one security model instead of a bespoke
  `author_association` check.
- **Resets the budget** — because §6.1 counts fixloop's own `<!-- fixloop:refire -->`
  re-fire comments (not reviews), resume **deletes those marker comments** so the next
  count reads 0 — a fresh set of 3 automated attempts. **Dismissing reviews does NOT
  reset a comment-based count.** (The original design reset by dismissing
  `CHANGES_REQUESTED` reviews; that was superseded
  when the count moved to markers to survive review.yml's comment-fallback path — §6.1.)
- **Removes** `agent:retry` + `agent:needs-human`, clears the assignee.
- **Re-fires** the builder in FIX MODE (as §6.1). The FIX-MODE prompt already reads
  the full PR conversation, so any comment you left is picked up as guidance
  alongside the reviewer's findings — nothing is parsed out of the label itself.
- From there it is the normal §6.1 loop again.

**(b) Take over the code yourself.** You push commits to the `claude/*` branch (or
edit files in the GitHub UI). Your push fires `synchronize` → CI + review re-run on
your commit. If the new review passes (`review-verdict = success`), the **gatekeeper**
clears the freeze: on its next ci/review-completion run it sees `agent:needs-human` on
an otherwise-green, non-conflicting PR, **removes `agent:needs-human`** (and the
escalation assignee, and reverses the issue mirror back to `agent:in-progress`), then
falls through to arm auto-merge — so the "stuck" state clears itself the moment the PR
is healthy again. The clear lives in `gatekeeper.yml`, **not** `review.yml` (the review
agent only posts the verdict; it never touches the freeze label). A still-failing or
still-conflicting frozen PR stays frozen, so the automated loop can't quietly escape its
own escalation. (Note: pushes by *you* re-run review because they are not made with the
default `GITHUB_TOKEN`; see the token note under Branch protection.)

**Resolution in both paths.** The terminal state is identical to any other PR: a
green CI + a `review-verdict = success` → gatekeeper auto-merges the PR to `staging`.
The linked issue does **not** close at that point, though: GitHub only honours a
`Closes #N` reference when it reaches the repo's **default branch** (`bridge`), and
agent PRs merge into `staging` (non-default). So the issue stays open through alpha
integration and auto-closes on the `staging → bridge` promotion — provided `Closes #N`
actually survives into a commit that lands on `bridge` (with a squash merge, the
squash commit message must carry it; worth confirming on the first real run). The PR's
`loop:*` / `agent:*` working labels stay on the now-closed PR (harmless — nothing
strips them on merge). Nothing about the escalation leaves residue once resolved.

### 6.4 What must be built for §6

- ✅ `fixloop.yml` (`on: workflow_run` of `review` → read `review-verdict` → round count,
  re-fire, or escalate) — **built.** Uses the built-in `GITHUB_TOKEN`.
- ✅ FIX-MODE branch in the routine prompt (build-agent-routine.md) — **built** (but the
  *live* routine prompt at claude.ai must be re-pasted; the doc edit alone doesn't take).
- ✅ FIX-MODE work-item construction in the fire call — **built** (in `fixloop.yml`,
  shares the §1 `/fire` plumbing).
- ✅ Repo variable `MAINTAINER_HANDLE` (escalation @-mention/assignee) — already set.
- ✅ §5 verdict (hard dependency) — done.
- ✅ `resume.yml` (`on: pull_request_target` labeled `agent:retry` → delete the
  `fixloop:refire` AND `conflictwatch:refire` marker comments to reset both budgets →
  re-fire in FIX MODE, with a rebase note when the PR is conflicted) — **built.** Uses
  `GITHUB_TOKEN`. `pull_request_target` (not `pull_request`) because GitHub creates no
  `pull_request` runs for a conflicted PR — the old trigger made `agent:retry` silently
  dead on conflict-frozen PRs; fork PRs are excluded by a job guard.
- ✅ A repo label `agent:retry` (maintainer-applied resume trigger) — **created.**
- ✅ **Conflict → rebase FIX MODE** — **built** in `conflict-watch.yml` +
  `.github/scripts/rebase-refire.sh` (§6.5), with `sweep.yml` as the level-triggered
  backstop: fires FIX MODE with a rebase instruction on the events a conflicted PR
  actually emits, marks attempts with `<!-- conflictwatch:refire base=<sha> -->`
  (its own `MAX_REBASE_ROUNDS` budget, separate from `MAX_FIX_ROUNDS`), and freezes
  (`agent:needs-human`) if the conflict outlives the budget. (Previously a
  `gatekeeper.yml` branch on the shared fixloop budget — structurally dead for
  born-conflicted PRs, which emit no ci/review runs for `workflow_run` to hear.)
- 🔲 Live end-to-end verification against a real change-request.
- **No `GATEKEEPER_TOKEN` / PAT** — the `workflow_run` trigger (§6.1) sidesteps the
  recursion guard, and the re-fire happens through the routine (the `app/claude`
  App pushes, which already re-triggers CI/review). So the whole loop runs on the
  built-in `GITHUB_TOKEN` + the existing `ROUTINE_FIRE_TOKEN`.

### 6.5 · Merge conflicts — nothing force-merges; conflict-watch rebases

A `claude/*` PR that conflicts with `staging` is `mergeable: false` /
`mergeStateStatus: DIRTY`. **GitHub's native auto-merge refuses a conflicted PR and
disables itself**, so a conflict *never* produces a bad merge — the PR simply
stalls. The recovery is event-driven, and the events matter, because a conflicted
PR is nearly invisible to the rest of the loop: **GitHub creates no `pull_request`
workflow runs while a PR has a merge conflict** (it can't build the `refs/pull/N/merge`
ref those runs are defined on), so ci and review never start, so the
`workflow_run`-triggered gatekeeper/fixloop never hear about the PR at all. A PR
*born* conflicted (opened after a sibling merged first — the normal parallel-issue
race) therefore produces **zero** events on the old design and stranded silently
(this bit PRs #111/#112 on 2026-07-12).

**`conflict-watch.yml`** owns recovery, listening on the two events a conflict does
produce:

1. **`pull_request_target` (`opened`/`reopened`/`synchronize`)** — runs in the base
   branch's context, no merge ref needed, so it fires even for a conflicted PR.
   Catches the born-conflicted case within seconds. (Security: fork PRs are excluded
   by the job guard, and nothing from the PR head is ever checked out — see the
   workflow header. `review.yml` stays `on: pull_request`; that invariant is
   untouched.)
2. **`push` to `staging`** — the moment a sibling merge *creates* conflicts on the
   other open agent PRs (their own events never fire; the base moved, not their
   heads). Scans all open same-repo `claude/*` PRs.

Both paths call **`.github/scripts/rebase-refire.sh`** — the single owner of the
rebase re-fire — which re-fires the **originating builder** in FIX MODE with the
rebase instruction: *"merge `origin/staging` into `claude/<slug>`, resolve the
conflicts, push — do not open a new PR."* The push emits `synchronize` → CI + review
run on the resolved tree → a fresh verdict, exactly like a normal fix round.

**Separate budget (deliberate).** Rebase attempts are marked
`<!-- conflictwatch:refire base=<staging-sha> -->` and capped by
**`MAX_REBASE_ROUNDS` (5) per staging head** — *not* the fix loop's
`MAX_FIX_ROUNDS`, and *not* a lifetime count. With N parallel agent PRs, every
sibling merge legitimately re-rebases the others; on a shared or lifetime budget
that churn could freeze an innocent PR that never failed to converge. Counting only
markers whose `base=` is the *current* staging head makes the cap measure
non-convergence (repeated failures against one staging state) — a successful rebase
leaves its marker behind on a superseded base, and the budget naturally resets when
`staging` moves. The escalation guarantee is unchanged: a conflict that outlives its
budget on one staging head freezes the PR with `agent:needs-human` + a maintainer
@-mention. The embedded staging SHA also dedupes:
an `opened`/`push`/sweep event won't re-fire while an agent is already rebasing onto
the current staging head (a same-base marker older than ~2 h is considered a dead
agent and re-fired; a `synchronize` event — a fresh head push, i.e. the previous
attempt concluded — never dedupes). While a **soak** is open, non-soak-fix PRs are
deferred (their budgets aren't churned by soak-fix merges; sweep re-fires any
still-DIRTY PR after the thaw).

**Backstops.** `sweep.yml`'s DIRTY branch calls the same script on its ~30-min cron
(dropped events self-heal; sweep shares conflict-watch's concurrency group so an
overlapping cron can't double-fire an in-flight rebase — the marker read/post isn't
atomic), and `resume.yml`'s `agent:retry` resets **both** budgets
(it too runs on `pull_request_target`, so it works on the conflicted PRs it exists to
rescue). The gatekeeper does nothing on `DIRTY` — arming is impossible there and the
re-fire is no longer its job.

**Status.** 🟢 Built (`conflict-watch.yml` + `rebase-refire.sh` + the sweep/resume
changes above), replacing the earlier `gatekeeper.yml` branch, which shared
`MAX_FIX_ROUNDS` and — being `workflow_run`-triggered — could never see a
born-conflicted PR. **Activation:** the `pull_request_target`/`push` triggers read
the workflow from the event's base branch, so conflict-watch and resume are live once
merged to `staging`; the sweep backstop is `schedule`-triggered (default branch) and
activates on promotion to `bridge`, like `fixloop.yml`.

*Optional hardening:* branch protection's **"require branches up to date before
merging"** (`strict`, currently off) surfaces staleness earlier by forcing a rebase
before every merge — but it only *surfaces* conflicts, it doesn't resolve them.

---

## 7 · Gatekeeper auto-merge

**Drives.** On CI + review completing for a `claude/*` PR into `staging`,
`.github/workflows/gatekeeper.yml` arms native auto-merge with no human.

**Enforces.** GitHub deliberately won't let a bot's *approval* satisfy branch
protection, so the pattern is: protection requires **status checks** (not human
approval), and the gatekeeper flips on native auto-merge once they pass.

**Status.** 🟢 Built & verified — PR #19 (a green `claude/dps-formatter → staging`)
**auto-merged with zero human action**: gatekeeper `skipped` on non-agent branches,
armed auto-merge on #19, and native auto-merge merged it once all four required
checks went green.

**How it works.**
- **Trigger.** `on: workflow_run` completion of `ci` + `review` — plus `push` to
  `session-done/**` and `pull_request: synchronize` for the interlock (§7.2). Guard: same-repo,
  PR head `claude/*` (base `staging`).
- **Gate.** Merge only if **all** hold: both `ci` job contexts = `success`, the
  `review-verdict` context = `success`, no `agent:needs-human` label present, **and** a
  `session-done` marker exists for the PR's current head (§7.2).
- **Action.** `gh pr merge {n} --squash --auto` using a **`craig-the-intern-bot` App
  installation token** (minted in-job by `actions/create-github-app-token` from the
  `BOT_APP_ID` / `BOT_APP_PRIVATE_KEY` secrets), *not* `GITHUB_TOKEN`. `--auto` hands off to
  *native* auto-merge, so branch protection does the final "wait for green" — the job just
  arms it. A non-`GITHUB_TOKEN` member identity is required because the merge **must** trigger
  downstream: a `GITHUB_TOKEN` merge is swallowed by the recursion guard, so `post-merge.yml`
  (`recut-alpha`) would never fire on a soak-fix merge. A **loud preflight** fails the run if
  the App token failed to mint rather than silently arming with `GITHUB_TOKEN`.
- **On verdict = failure** it does nothing; §6 owns that path.
- **On conflict (`DIRTY`)** it does not merge and does nothing further — arming is impossible on a DIRTY PR, and `conflict-watch.yml` owns the rebase re-fire (§6.5).
- **Prerequisites.** Enable the repo's **"Allow auto-merge"** setting (a repo toggle,
  not a token). The arming itself uses the **`craig-the-intern-bot` App token** (see 9.3) so
  the merge fires `post-merge`.

### 7.1 · The sweep — a level-triggered safety net (`sweep.yml`)
The gatekeeper is **edge-triggered** (it acts on ci/review *completion*), which strands PRs
in one case: a PR **held through a soak** is re-armed only by the `post-merge` thaw the instant
a promotion lands — exactly when GitHub is recomputing mergeability (`UNKNOWN`), so arming can
fail, and an idle held PR gets no fresh event to retry (this is what happened to #54). The
**sweep** closes that gap by *reconciling to the desired state* on a timer (`on: schedule`,
~30 min, + `workflow_dispatch`): when **no soak is open**, it merges any green, idle, un-armed
agent PR — polling `mergeStateStatus` past the transient `UNKNOWN` first, then merging only the
`CLEAN` ones. It is **exactly as restrictive as the gatekeeper** — same-repo `claude/*` only
(`isCrossRepository == false`, so forks are excluded), skips `agent:needs-human`, and merges
with a plain `gh pr merge` (**no `--admin`**) so branch protection — crucially `review-verdict`
— still gates. A fork PR can't obtain `review-verdict` (no secrets on a `pull_request` from a
fork), so the sweep can never merge one; this depends on `review.yml` staying `on: pull_request`
(never `pull_request_target`). Same `craig-the-intern-bot` App token + loud preflight as the
other merge paths.
The sweep is also the **level-triggered backstop for §6.5**: a `DIRTY` candidate is no longer
skipped — it's re-fired through the same `.github/scripts/rebase-refire.sh` (same separate
rebase budget, same staging-SHA dedupe), so a dropped conflict-watch event self-heals within
a sweep cycle.

**Known narrow gap (frozen-PR recovery is edge-triggered).** The §6.3(b) auto-clear — a frozen
(`agent:needs-human`) PR that goes green again is un-frozen and armed by the gatekeeper — fires
only on that PR's own ci/review *completion*. If GitHub still reports `mergeable = UNKNOWN` at
**both** the ci- and review-completion events, the clear is skipped and the PR stays frozen, and
the sweep **deliberately skips `agent:needs-human` PRs** (it must not auto-merge something a human
owns), so there is no level-triggered retry for that specific case. In practice this is very
narrow: mergeability is recomputed within seconds, long before the (minutes-long) review finishes,
so by the review-completion event `UNKNOWN` has essentially always resolved — and a human is
already looking at a frozen PR, so a stuck one is visible, not silent. If it ever bites, the fix is
to let the sweep re-evaluate frozen-but-otherwise-green PRs (clearing the freeze exactly as the
gatekeeper does), rather than merging them blindly.

### 7.2 · Session interlock — no merge until the authoring session ends

**Why.** The gatekeeper arms auto-merge the instant `ci` + `review-verdict` go green — which
is decoupled from whether the **authoring agent session has actually finished**. In **PR #115**
the fix agent was still running when review passed; auto-merge fired and squash-merged the
head, and **54 s later** the same session pushed a real correction (`2b6acae`) to the
now-merged branch, where it stranded (rescued later as a separate PR). The model declaring
itself "done" mid-run is not a reliable signal — it literally reversed its own conclusion
after saying so. The interlock adds the missing gate input: **the authoring session has
terminated.**

**The marker.** A Claude Code **`SessionEnd` hook** (`.claude/hooks/session-done-marker.sh`,
registered via committed `.claude/settings.json`) fires when the cloud session *actually*
ends — a harness signal, not the model's judgment — and pushes a marker branch
**`refs/heads/session-done/<head-sha>`** at the session's head commit. Why a branch and not a
tag/status: in the cloud env `gh` is absent and GitHub goes through a scoped MCP server
(agent-only — a hook subprocess can't use it) or a local git proxy that accepts **only
`refs/heads/*` pushes** (custom refs and tags → HTTP 403). The hook no-ops outside a remote
pipeline run (guards: `CLAUDE_CODE_REMOTE=true` + a `claude/*` branch), so a maintainer's local
sessions never touch it. Marker existence is checked with `gh api .../git/ref/heads/session-done/<sha>`.

**The gate (gatekeeper).** Before arming, the gatekeeper now also requires a `session-done`
marker for the PR's **current** head. Two extra triggers make this prompt rather than reliant
on the sweep:
- **`push` to `session-done/**`** — the marker landing *is* the wake-up. This is what closes
  the #115 timing exactly: if the session is still running when review completes, the
  `workflow_run` arm attempt finds no marker and holds; when the session ends, the marker push
  re-triggers arming. The push path only arms for a marker that is some open PR's **current**
  head (a stale marker matches nothing).
- **`pull_request: synchronize`** — because native auto-merge, once armed, merges *any* future
  green head, a new commit landing after arming would otherwise slip through un-marked. On a
  head move, if the PR is armed and the new head has no marker yet, the gatekeeper **disarms**;
  it re-arms when that head's marker lands. Invariant: *auto-merge is armed only while the
  current head has a marker.*

**Sweep's role (backstop only).** `sweep.yml` honors the **same** marker gate — it must not
merge a still-running session's head. The **one** bypass is the **crash backstop**: `SessionEnd`
does not fire on a hard `SIGKILL`, so a green, marker-less PR whose head has been idle past
`CRASH_MIN` (45 min) is merged anyway, loudly noted, rather than stranded forever. The sweep is
no longer the *normal* arming path for the interlock (the marker push is) — only the rare
crash net. It also **GCs** orphan `session-done/*` markers (any whose sha isn't an open PR's
current head), bounding branch clutter.

**Status.** 🟡 Built (this change), **not yet live-validated.** Two routine-specific facts can
only be confirmed once the hook is on the routine's startup-checkout branch (it registers at
session start) and a real routine run has exercised it: **(a)** `SessionEnd` fires in the
API-fired Routine (confirmed only for `Stop` in an interactive web session so far), and **(b)**
the Routine's `HEAD` at `SessionEnd` equals the PR head. Until then, the crash backstop means a
non-firing hook degrades to "merges ~45 min late," not "never merges."

**What must be built for §7.2.** ✅ the hook + `.claude/settings.json`; ✅ gatekeeper marker
gate + `push`/`synchronize` triggers + synchronize-disarm; ✅ sweep marker gate + crash backstop
+ marker GC. ⏳ live validation of (a)/(b) above on a Routine run.

### 7.2b · Bot identity — the loop acts as `craig-the-intern-bot[bot]`, not a human
Every automated action in the loop is attributed to the **`craig-the-intern-bot` GitHub App**
(org-owned under `white-bag`, installed on this repo), split across two mechanisms:

- **Commits** — a sibling **`SessionStart` hook** (`.claude/hooks/session-identity.sh`, registered
  in the same `.claude/settings.json` as the §7.2 marker hook) points git's author/committer at
  the App bot's noreply address `304674093+craig-the-intern-bot[bot]@users.noreply.github.com`
  (GitHub matches the bot user id + slug in that address for attribution). Same **cloud-only guard**
  as the marker hook — `CLAUDE_CODE_REMOTE=true`, unset in a maintainer's local CLI — so **local
  commits keep the maintainer's own identity**; only cloud-routine commits become the bot.
- **Token-driven actions** — merges, the `staging → bridge` promotion PR, and the fix-loop
  auto-accept marker comment run on a **short-lived App installation token** (minted in-job by
  `actions/create-github-app-token` from the `BOT_APP_ID` / `BOT_APP_PRIVATE_KEY` secrets), a
  non-`GITHUB_TOKEN` member identity — see §9.6 for the token ledger and why a member identity is
  required (recursion guard + external-contributor gate).

This replaces the earlier `MERGE_PAT` (a long-lived personal fine-grained PAT): same member
identity, but scoped, ~1h-expiry tokens with no rotation toil, and a single coherent bot identity
across commits *and* the token-driven actions instead of the maintainer's account appearing to
merge its own agent's PRs.

### 7.3 · Triage gate — a passing review's medium+ findings get a decision (lows are informational)

**Why.** `review-verdict` is a *deterministic* function of the findings: it fails only on a
**high/critical** finding (plus the `.github` tripwire and the missing-issue-link check).
**Medium/low findings always produce `success`** — they're posted as inline `COMMENT` findings
but, before this, nothing ever acted on them: the fix loop fired only on `failure`, so a PR
merged with them silently unaddressed. The triage gate makes the agent **decide** each one
first. (`review.yml` is untouched — the workflow-parity guard requires it byte-identical to the
default branch — so triage reads its *existing* outputs.)

**Detecting "passed with findings."** The reviewer posts each line-anchored finding as an inline
review comment (`/pulls/{n}/comments`) at the reviewed head sha, severity-tagged `**[low|medium|
high|critical]**` in the body. The fix loop, gatekeeper, and sweep all count `github-actions[bot]`
inline comments whose `commit_id` == the current head **and that are NOT `**[low]**`** — i.e.
**medium-and-up** only (high/critical already fail the verdict, so on a pass that means "a
medium"). **`low` findings are informational: posted on the PR for the record, but never triaged
and never gated** — the reviewer stays comprehensive (its thoroughness is what caught the #129
`sweep` bypass as a *high*), while nit-level lows don't cost a triage run or hold a merge. All
three counters apply the identical non-low filter, so a low-only PR is never held waiting for a
`session-triaged` marker that would never come. (Known gap: a *file-level* finding with no line
anchor lives only in the review body, so it isn't counted — rare, and never blocking.)

**The loop (`fixloop.yml`).** On `review-verdict = success` with unaddressed findings on the head
and no `session-triaged` marker for it yet, the fix loop re-fires the agent in **TRIAGE MODE**
(routine prompt): fix the worthwhile findings (→ push → normal re-review) or reply-to-**decline**
the rest — **the agent's call is final** (the chosen Q2 policy). A **separate budget**
(`MAX_TRIAGE_ROUNDS`, marker `<!-- fixloop:triage -->`) from the fix rounds, so nit-churn can't
starve real fixes. **Budget spent → auto-accept** (the loop posts the `session-triaged` marker
itself, **via the `craig-the-intern-bot` App token** — a `GITHUB_TOKEN`-authored comment is swallowed
by GitHub's recursion guard and would never wake the gatekeeper's `issue_comment` trigger, stranding
the PR until the next sweep; observed on #138): medium/low are non-blocking, so they must never freeze a PR — the
opposite of the fix loop's escalate-on-exhaustion. The TRIAGE MODE prompt also tells the agent to
address *only* the listed findings in one pass (no extra polishing/refactoring), since every extra
commit moves the head and re-triggers the whole review+triage cycle.

**The gate + signal.** Triage-complete is a **comment** marker `<!-- session-triaged: <head-sha> -->`
— posted by the agent when it declines-only (it can post via MCP; a decline changes no code so
the head is unchanged), or by the loop on auto-accept. Comment, not branch (unlike §7.2's hook
marker), because the *agent/loop* posts it and both can comment; only the subprocess hook was
constrained to a branch push. The gatekeeper gains an `issue_comment` trigger (filtered to that
marker) so the comment itself wakes arming, and its arm path now also requires: the current head's
review is complete (`review-verdict = success` on that exact sha, so the finding count is stable),
and if that head has findings, a matching `session-triaged` marker exists — else it holds. No
sweep dependence for the happy path: the marker comment is the edge trigger. But `sweep.yml`
(the second, level-triggered merge path) **also** enforces the triage gate in its `CLEAN`
branch — it must be exactly as restrictive as the gatekeeper, or it would merge a held PR on
its next cycle — with an analogous idle-past-`CRASH_MIN` backstop, which doubles as the recovery
for a triage agent that died before posting the marker (the fix loop's auto-accept can't fire
then, since a decline-only crash produces no new review event).

**Status.** 🟡 Built (this change), not yet live-validated — shares §7.2's dependency on a real
Routine run (TRIAGE MODE is a new routine-prompt mode; the prompt lives in the routine config, so
`docs/build-agent-routine.md` must be re-pasted there — see its ⚠️ note).

**What must be built for §7.3.** ✅ fixloop TRIAGE branch (detect findings, separate budget,
auto-accept); ✅ gatekeeper triage gate + `issue_comment` trigger; ✅ **sweep triage gate + crash
backstop** (mirror, so the second merge path can't bypass the hold); ✅ routine-prompt TRIAGE MODE.
⏳ re-paste the routine prompt; ⏳ live validation on a Routine run.

---

## 8 · Release — the human ship button

**Drives.** `.github/workflows/release.yml` runs **only** `on: workflow_dispatch`
(input `channel: alpha|beta`). On a `windows-latest` runner it builds `bridge.jar`
(Gradle 7.4.2), installs overlay deps, `npm run build` + `electron-builder --win
--x64`, reads `overlay/package.json` version, and `gh release create v$VERSION
--prerelease` with the installer + jar as assets.

**Enforces.** The manual-dispatch-only trigger *is* the release gate — nothing
publishes without a human pressing it, which encodes the never-release-without-an-
explicit-ask rule. The version now **auto-bumps** on dispatch (see below); the gate is
the dispatch itself, not the version bump.

**Status.** 🟢 Built, incl. the release-notes captain.

- **Release-notes "captain" — built.** A preceding `notes` job runs a Haiku agent
  (`claude-haiku-4-5`, `CLAUDE_CODE_OAUTH_TOKEN`) over this build's Conventional Commits —
  for an **alpha**, the same `origin/bridge..HEAD` range as the PR list (this soak's
  un-shipped content, NOT the git-describe range, which walks back to an old tag and re-lists
  every prior soak — see §9.1); for a **beta**, since the last tag — which writes `release-notes.md`;
  the Windows publish job downloads it and passes `--notes-file`. **Best-effort:**
  every captain step is `continue-on-error` and the publish job falls back to the old
  static note (`"Automated {channel} build from {ref}"`) if no notes were produced, so
  a captain failure can never block a release. Not yet exercised live (needs a real
  dispatch). Model per spec §04: `claude-haiku-4-5`.
- **Auto version-bump — built.** A step seeds from the latest published release tag,
  increments the patch, and applies the channel suffix (`v0.9.27-alpha` → `0.9.28-alpha`
  for alpha, `-beta` for beta), writing it into `overlay/package.json` in the runner
  before the build so the app + installer carry it. Nothing is committed back — the
  **latest release tag becomes the source of truth** (no push to a protected branch
  needed), so the repo's `overlay/package.json` version is now only a fallback seed and
  may lag. The release gate is unchanged: the human dispatch is still the only trigger.

---

## 9 · Alpha soak → promote or fix (the release feedback loop)

**Drives.** An alpha release (§8) publishes an installer; then the loop **doesn't end
until the tested changes land on `bridge`**. On publish it opens a **soak tracking
issue** and waits on a maintainer verdict expressed as a label: `soak:pass` promotes
`staging → bridge`; `soak:fail` re-enters the fix loop (fix-forward). Any change that
lands on `staging` while a soak is open **auto-cuts a fresh alpha** so the installer
under test always matches `staging`'s HEAD.

**Enforces.** The verdict labels are **maintainer-only** (applying a label needs write
access — the same gate as §1 kickoff). Promotion to `bridge` is a **PR with a stamped
`review-verdict`** (the built-in token can't *push* to protected `bridge`, so it merges
via a PR instead — no elevated token, 9.3). The *initial* alpha dispatch (§8) remains
the human release gate.

**Status.** 🟡 Built, pending deploy (PRs #41 workflows + #42 review-skip). Decisions
locked: **fix-forward, auto-cut, labels, PR-based promote (no token), latest-on-promotion**.
The release pipeline was renamed **release staging**; the `bridge` "latest" release is
its `beta` channel, auto-cut on promotion (9.3). Not yet live-verified.

### 9.1 · The soak tracking issue
On a successful alpha publish, the **release staging** pipeline (`release.yml`, alpha
channel only) opens an issue
`🧪 Alpha soak: v<version>`, labeled `soak`, whose body is the changes since the last
promotion + the installer link + the verdict instructions. Opened with the built-in
`GITHUB_TOKEN` (`issues: write`) — no PAT needed. **One soak issue per published
alpha**: a re-cut (9.5) opens a new one and closes the prior as *superseded*, so each
alpha keeps a clean, self-contained verdict record.

> **"Pull requests in this build" boundary** — the issue's PR list is
> `origin/bridge..HEAD` (PRs on `staging` not yet promoted to the stable branch),
> **not** a `git describe`-from-the-last-tag range. `gh release create` tags the
> default branch (`bridge`) by default, so alpha tags don't advance as `staging`
> accumulates a soak's PRs; a tag-based boundary sticks at the last promotion
> *reachable from `staging`* and re-lists every prior soak's PRs. `bridge` only
> moves on a promotion (a passed soak), so the branch diff is exactly this soak's
> own, un-shipped content. The Haiku **release-notes captain draws from this SAME
> `origin/bridge..HEAD` range for an alpha** (a beta uses the tag range, since
> `origin/bridge..HEAD` is empty when cut from `bridge`) — so the "What changed"
> notes and the PR list describe the same build, not every soak since v0.15.0.

### 9.2 · Verdict — `soak:pass` / `soak:fail`
Two maintainer-applied labels on the soak issue, read by `on: issues: labeled`
workflows scoped to issues that carry the `soak` label. Applying a label requires
write/triage permission, so — exactly like kickoff — GitHub guarantees a maintainer;
no author check needed.

### 9.3 · Pass → promote to `bridge` (PR-based, review-skipped, via the `craig-the-intern-bot` App)
`soak:pass` promotes **via a PR, not a direct push**. The `soak-verdict.yml` `soak:pass`
handler:

1. Opens a `staging → bridge` PR ("Promote — soak v<version> passed"), **authored by the
   `craig-the-intern-bot` App token** — a short-lived installation token minted in-job by
   `actions/create-github-app-token` (Contents + Pull requests, this repo only).
2. **Stamps `review-verdict = success`** on the PR head SHA (on the built-in `GITHUB_TOKEN`)
   — `soak:pass` *is* the human approval, standing in for a re-review (the same "manually
   stamp the verdict" pattern used for fork PRs under *Cross-cutting: merging outside*).
3. Enables native auto-merge **with the App token** (`--merge`, to preserve per-commit history
   + `Closes #N`).

A **loud token preflight** runs first: if the App token fails to mint (bad/missing
`BOT_APP_ID` / `BOT_APP_PRIVATE_KEY`, or the App isn't installed) the handler comments on the
soak issue and **fails the run**, rather than silently falling back to `GITHUB_TOKEN` (which
would re-break the promotion invisibly).

**The agent review is skipped on promotion PRs:** `review.yml` gets a one-line `if:`
guard so it does *not* run on a `staging → bridge` PR (head `staging`, base `bridge`) —
otherwise it would re-review the aggregate and could veto a soak you already approved. This
guard is load-bearing precisely because the PAT-authored PR *is* a real `pull_request` that
would otherwise trigger the review.

**Why the PAT — two GitHub gates both key on the actor.** Were the promotion PR authored by
the built-in `GITHUB_TOKEN`: (a) the *recursion guard* would suppress its `on: pull_request`
runs so `ci` never fires, **and** (b) the *"require approval for external contributors"*
setting would park its `ci`/`review` runs in `action_required` (a `github-actions[bot]`
author isn't a member). A PAT owned by the repo **owner** clears both — the promotion PR is
an ordinary `pull_request` from a member, so `ci` (overlay/bridge/`workflow parity`) runs
normally (no dispatch workaround), and the PAT-armed *merge* carries a member identity so
`pull_request: closed` fires and `post-merge.yml`'s `cut-latest` runs. With `ci` + `workflow
parity` green plus the stamped verdict, auto-merge merges. **Safety:** only the `soak:pass`
handler stamps the verdict, so a promotion PR opened any other way still has *no* verdict →
stays blocked.

The promoted commits' `Closes #N` auto-close their issues (verified live: #36 closed on
promotion). The soak issue is **closed when the promotion actually lands on `bridge`**
(`post-merge.yml` `cut-latest`, alongside the thaw) — *not* at `soak:pass` label time.
Closing it early would drop the open-`soak` count to 0 and lift the §9.5 freeze *during* the
promotion's in-flight window (letting unrelated PRs move `staging`), and if the promotion
then failed to merge the loop would be wedged with no tracking issue. The §9.5 freeze keeps
`staging` stable through that window, so deferring the close is both safe and race-free.

**When the promotion lands on `bridge`, a LATEST release is auto-cut** (`post-merge.yml`,
`cut-latest`): it dispatches the release pipeline on the `beta` channel from `bridge`,
which does a **bigger (minor) version bump, no prerelease suffix, published as GitHub's
"Latest" release** (not a prerelease). So the human `soak:pass` cascades to: land on
`bridge` → stable/latest release. This is the one auto-trigger that *does* touch `bridge`
— but only downstream of the human `soak:pass`, never from auto-cut (§9.5). Version
scheme: alpha soak builds bump the **patch** (`0.9.29-alpha → 0.9.30-alpha`, prerelease);
the latest bumps the **minor** (`0.9.29-alpha → 0.10.0`, Latest).

*(Requires the review.yml skip-guard — a parity-guarded change, so it lands on `bridge`
first, syncs to `staging`, admin-merged like the `allowed_bots` fix — and the repo's
"Allow merge commits" setting on.)*

### 9.4 · Fail → fix forward
`soak:fail` fires the **build agent** through the routine `/fire` in **BUILD MODE** (a
new fix, not an existing-branch FIX MODE) with a work item built from the soak issue:

```
ALPHA SOAK FAILED for v<version>. Reported broken during live testing:
<soak issue body + comments>
Diagnose and fix it; open a fix PR into `staging`. If a repro capture is included,
reproduce it via FakePacketSource and add a regression test first.
```

The fix PR then flows through the normal loop unchanged — §4 CI, §5 review, §6 fix
loop if the review requests changes, §7 gatekeeper auto-merge to `staging`.
**Fix-forward** is the chosen default; reverting a specific offending change is a manual
option, not automated. (No routine-prompt change is needed — the default new-branch
routine mode, "BUILD MODE" in the routine prompt, already handles a bug brief; the
soak-fail work item *is* one.)

### 9.5 · Auto-cut — a fresh alpha whenever `staging` moves during a soak
**Chosen: auto-cut.** A workflow `on: pull_request: closed` with
`if: merged && base == staging` checks whether an open `soak` issue exists; if so it
re-dispatches the alpha: `gh workflow run release.yml --ref staging -f channel=alpha`.
That publishes a new installer, opens a new soak issue (9.1), and closes the prior soak
as superseded. `post-merge.yml` is concurrency-guarded (serialize, not coalesce), and
`release.yml` carries its own per-channel concurrency guard so two racing re-cuts can't
compute the same version and collide on the tag.

This deliberately covers **any** merge to `staging` during a soak — a `soak:fail` fix
*or* an unrelated agent PR — because either staleness means the installer under test no
longer matches `staging`, so the honest thing is to re-soak the new HEAD.

**Convergence hazard + resolution (soak-freeze).** Taken alone, "re-cut on *any* staging
merge" can **livelock**: under sustained dev-loop traffic, unrelated `claude/*` PRs merge
to `staging` continuously, each one re-cutting the alpha and superseding the soak issue
before the maintainer can apply a verdict — so a soak never reaches `soak:pass` and
`bridge` never gets promoted. The concurrency guard only debounces *bursts*, not sustained
traffic. **Resolution — freeze `staging` for the soak's duration:** while an open `soak`
issue exists, the **gatekeeper (§7) holds unrelated agent PRs** (does not arm auto-merge;
they queue) so `staging`'s HEAD is stable during the soak. Only **`soak:fail` fixes** are
exempt — recognized primarily by a workflow-defined **`soak-fix` label** the fix agent
applies (the `soak:fail` brief instructs it; a label the loop owns is robust against
free-text phrasing drift), with a `Addresses soak #N` body reference as a fallback; they
still merge + re-cut, since converging the soak *is* the point. When the soak resolves
(`soak:pass` promotes and lands, or the fix loop completes), the freeze lifts —
`post-merge.yml`'s **thaw** arms the held PRs — and the queue drains. This keeps the
"re-soak on change" guarantee (staging only moves for soak-fixes) while guaranteeing the
soak converges. *(Built in PR #41: the gatekeeper hold, the `soak-fix` label/reference
exemption, and the `post-merge.yml` thaw.)*

**Hard boundaries (both enforced by construction):**
- **Strictly during a soak.** Auto-cut is a no-op unless an open `soak` issue exists —
  so a `staging` merge with no soak in progress publishes nothing.
- **Never to `bridge`.** Auto-cut *only* re-dispatches the **alpha** (`--ref staging`,
  `channel=alpha`). It never promotes, never targets `bridge`, never cuts a beta. The
  **only** path to `bridge` is your explicit `soak:pass` label (9.3). So nothing reaches
  the trunk without a human press — auto-cut softens only the *alpha* re-release, never
  the promotion.

> **Release-gate note.** The *initial* alpha is a manual dispatch — the human chooses to
> start a soak. Auto-cut re-releases are continuations of that already-started soak, not
> new unattended releases; but they **do publish alphas without a per-release press**.
> That's the one place this trades a bit of the "manual-dispatch-only" gate for a closed
> loop — but only for the throwaway alpha, never for `bridge` (see boundaries above).

### 9.6 · What must be built for §9
Built in **PR #41** (workflows) unless noted:
- **`release.yml` → "release staging"**, channel-aware: `alpha` = soak build (patch+1,
  `-alpha`, `--prerelease`) that opens the soak issue after publish; `beta` = the **latest**
  release (minor bump, no suffix, `--latest` not `--prerelease`), auto-cut on promotion.
- `soak-verdict.yml` (`on: issues: labeled`): `soak:pass` → open the `staging → bridge` PR
  **as the `craig-the-intern-bot` App** (so `ci` runs naturally and the merge fires `post-merge`),
  stamp `review-verdict=success` (on `GITHUB_TOKEN`), arm auto-merge **as the App** — all behind
  a **loud token preflight** (the soak issue closes later, when the promotion lands; the no-diff
  "nothing to promote" case closes + thaws here so the freeze can't wedge); `soak:fail` →
  ensure the `soak-fix` label, then `/fire` the fix agent (`GITHUB_TOKEN` + `ROUTINE_FIRE_*`).
- `post-merge.yml` (`on: pull_request: closed`; `actions: write` to dispatch, `issues: write`
  + `pull-requests: write` for the close + thaw): a staging merge during a soak re-cuts the
  alpha; a `staging → bridge` promotion landing cuts the latest release, closes the soak
  issue, and thaws the freeze (arms any held agent PRs). Now reliably reached because the
  gatekeeper/promotion merges are made by the `craig-the-intern-bot` App token, not `GITHUB_TOKEN`. **Code-gated:**
  both auto-dispatches only fire when the merged PR touches *buildable* code — a PR whose
  files are all `.github/**` / `docs/**` / `*.md` / root config yields a byte-identical app,
  so the release is skipped (the close + thaw still run). Fail-safe: any file outside that set
  counts as code. The *manual* `release.yml` dispatch is never gated.
- `ci.yml` runs `on: pull_request` only — the promotion PR is a real `pull_request` authored
  by the `craig-the-intern-bot` App, so `ci` runs naturally (the earlier `workflow_dispatch` workaround is gone).
- Repo labels `soak` / `soak:pass` / `soak:fail` / `soak-fix`; repo setting **Allow merge commits** on. The promotion PR is authored by the `craig-the-intern-bot` App (a member identity), so neither the "Allow GitHub Actions to create PRs" toggle nor the "require approval for external contributors" gate applies to it — keep that external-contributor gate **on** for real fork PRs.
- **The soak-freeze (§9.5)** — the §7 gatekeeper holds unrelated agent PRs while a `soak`
  issue is open, exempting soak-fix PRs (recognized by the `soak-fix` label, body reference as fallback),
  plus the `post-merge.yml` thaw. Folded into **PR #41**.
- **`review.yml` skip-guard** for `staging → bridge` PRs — **PR #42** (parity-guarded →
  `bridge`-first, admin-merged, then synced to `staging`).

**The `craig-the-intern-bot` GitHub App is the one non-default credential.** An org-owned App
(installed on this repo; Contents + Pull requests + Issues: read/write) whose short-lived
installation token is minted in-job by `actions/create-github-app-token` (from the `BOT_APP_ID`
+ `BOT_APP_PRIVATE_KEY` secrets) and used to **create the promotion PR**, **arm auto-merge**
(gatekeeper agent PRs + the promotion), and **post the fix-loop auto-accept marker**. It makes
those actions carry a member identity, so (a) downstream workflows fire on the merge/comment and
(b) the external-contributor approval gate doesn't apply — and every automated action (commits,
merges, promotion PRs, marker comments) reads as `craig-the-intern-bot[bot]` rather than a human
account. Everything else runs on the built-in `GITHUB_TOKEN`. A **loud preflight** in each
token-using merge/promotion job fails the run — with a comment — if the App token failed to mint,
never a silent fallback. This replaces the earlier `MERGE_PAT` (a long-lived personal fine-grained
PAT); the App gives the same member identity with **scoped, ~1h-expiry tokens and no rotation
toil**. (The still-earlier `PROMOTE_TOKEN` idea and the "no token at all" design were both wrong:
GitHub's recursion guard + the approval gate make a member-identity token unavoidable for the
merge/promotion — see 9.3.) Commit authorship is set separately — the `SessionStart` hook
`.claude/hooks/session-identity.sh` points cloud-routine git commits at the same bot (see
§"bot identity").

| Action | Token | Scope |
|---|---|---|
| Soak-issue open/close/comment + labels · verdict stamp | `GITHUB_TOKEN` | `issues: write` + `statuses: write` |
| `soak:fail` → fire the fix agent | `GITHUB_TOKEN` + `ROUTINE_FIRE_*` | — |
| Auto-cut / cut-latest → dispatch `release.yml` (`workflow_dispatch` is recursion-guard-exempt) | `GITHUB_TOKEN` | `actions: write` |
| **Create the promotion PR + arm auto-merge** (gatekeeper + promotion) · **fix-loop auto-accept marker** | **`craig-the-intern-bot` App token** (`BOT_APP_ID` + `BOT_APP_PRIVATE_KEY`) | Contents R/W + Pull requests R/W |

The auto-cut dispatch works on `GITHUB_TOKEN` because `workflow_dispatch` is one of the
two events *exempt* from GitHub's recursion guard (so a token-fired dispatch still runs
the release). The promotion also sidesteps the push-to-protected-branch problem by going
through a PR (9.3) instead of a push.

### 9.7 · Known limitation
The fix agent is **headless — no game**. A live-game-only visual/UX soak failure can't
be reproduced or regression-tested by the agent; those need precise written guidance or
a manual fix. The auto-fixable class is logic/DPS/decode bugs that come with a
FakePacketSource repro capture — same constraint as the normal `agent:fix` path.

---

## Cross-cutting: branch protection

**Enforces (should).** Per spec §03: required checks = `ci` **+ review**, 0 human
approvals, restrict who can push. This is what lets machine checks stand in for a
human approval click.

**Actual (verified 2026-07-10, both `staging` and `bridge`):**

| Setting | Spec | Actual | Gap |
|---|---|---|---|
| Required checks | `ci` + review | `ci` (2) **+ `review-verdict`** | ✅ added on both branches (verified gating #19/#23) |
| Required approvals | 0 | 0 | ✅ |
| Restrict who can push | yes | **none** | ⚠️ **N/A** — GitHub push restrictions aren't available on **user-owned** repos (only org repos). Mitigated: agents can't push to protected branches (they open PRs), and the required checks gate every merge |
| Enforce for admins | (implied) | **off** | 🟡 admins bypass all gates — kept off deliberately as the owner escape hatch (below) |
| Force pushes | off | off | ✅ |
| Strict (up-to-date before merge) | — | off | 🟡 lets a branch merge stale (a contributor to the staging drift class of bug) |

**Status.** `review-verdict` is now a required check on both `staging` and `bridge`
(step 3 done). The push restriction can't be applied on a user-owned repo — if this
repo ever moves under an org, add it then. A failing/absent verdict now blocks a
merge (a `review.yml`-changing PR self-skips → no verdict → blocked → needs an
`--admin` merge, which is exactly the escape hatch below).

## Cross-cutting: manual overrides & the escape hatch

You are the owner, and **`enforce_admins` is off on both branches** (verified), so
you bypass every gate — required checks, a failing `review-verdict`, an
`agent:needs-human` freeze, all of it. Two escape hatches:

- **Force-merge a blocked PR** (keeps clean history):
  `gh pr merge <n> --admin --squash -R white-bag/thessal`. The UI equivalent
  is the "Merge without waiting for requirements to be met" button, which appears
  for you precisely because admin-enforcement is off.
- **Land a commit directly**, skipping PR + CI + review entirely:
  `git push origin <local-branch>:staging`. Works because you're an admin and
  `restrictions` is `none`. This is the deliberate "I've decided, ship it" hatch —
  nothing validated it.

Constraints & tradeoff:

- **Force-pushes are blocked for everyone** (`allow_force_pushes: false`) — normal
  pushes only; you can't rewrite `staging`/`bridge` history.
- These overrides exist **only while `enforce_admins` is off**. If you later turn it
  on to stop *anyone* (including you) from bypassing the loop, you lose the
  one-command hatch — you'd have to toggle protection off, act, and toggle it back
  on. **Recommendation: keep `enforce_admins` off.** The loop's guarantees are for
  the *agents*; you overriding is a conscious human decision, not a hole an agent
  can exploit (agents can't apply labels or push to protected branches — §1, §3).

## Cross-cutting: merging outside / fork PRs

Anyone can open a PR (public repo), but a **fork** PR can't earn an automated
`review-verdict`: a `pull_request` from a fork receives **no secrets**, so
`claude-code-action` has no `CLAUDE_CODE_OAUTH_TOKEN` and the reviewer can't run.
The required `review-verdict` check therefore stays absent → the fork PR is
**fail-closed unmergeable** through the normal path. That's a safety property, not a
dead end — to land a good outside contribution, in increasing order of cleanliness:

1. **Admin-merge** — `gh pr merge <n> --admin --squash`. Bypasses *all* requirements
   (including CI), so review it yourself first. For tiny, self-evident PRs.
2. **Manually stamp the verdict** after you review — you act as the reviewer:
   `gh api -X POST repos/<repo>/statuses/<head-sha> -f state=success -f context=review-verdict -f description="manually reviewed"`.
   It then merges through the **normal** button, and — unlike `--admin` — CI still had
   to be green; you're only substituting for the one check a fork can't produce.
3. **Adopt as an internal branch (preferred).** Pull their commits onto a same-repo
   branch, where secrets *are* available, so the real reviewer runs:
   ```
   gh pr checkout <n>
   git push origin HEAD:contrib/<feature>
   gh pr create --base staging --head contrib/<feature> --body "Supersedes #<n>, thanks @<author>"
   ```
   Git preserves the author's commit credit; the internal PR gets a genuine
   `review-verdict` and merges normally. Close the fork PR pointing at it. This is the
   only path that actually runs the review agent on their code — use it for anything
   non-trivial.

## Cross-cutting: tokens & secrets

| Secret / token | Purpose | Present? |
|---|---|---|
| `ROUTINE_FIRE_URL` / `ROUTINE_FIRE_TOKEN` | §1 kickoff `/fire` | 🟢 |
| `CLAUDE_CODE_OAUTH_TOKEN` | §5 review agent (draws on Max, not metered API) | 🟢 |
| `MAINTAINER_HANDLE` (repo variable) | §6 escalation @-mention/assignee | 🟢 set (`hotmalehotmail`) |
| `BOT_APP_ID` / `BOT_APP_PRIVATE_KEY` | §7.2b/§9.6 `craig-the-intern-bot` App — merges, promotion PR, auto-accept marker | 🟢 |
| ~~`GATEKEEPER_TOKEN`~~, ~~`MERGE_PAT`~~ | Superseded by the `craig-the-intern-bot` App (§7.2b) | — |

**No `GATEKEEPER_TOKEN` (why the earlier plan dropped it).** GitHub's recursion
guard means actions taken with the built-in `GITHUB_TOKEN` don't trigger further
workflows. The *only* place that bit the §6 fix-loop trigger: if it keyed on the
reviewer's `pull_request_review`, that review is posted with `GITHUB_TOKEN`, so the
event would be suppressed. **We chose the `workflow_run` trigger (§6.1) instead** — it
fires regardless of token — so the fix loop itself needs no elevated credential.
**The merge/promotion paths do**, however: the gatekeeper arm, the sweep merge, the
`staging → bridge` promotion, and the fix-loop auto-accept marker all run on the
`craig-the-intern-bot` App token (not `GITHUB_TOKEN`), precisely because
`post-merge.yml` (and the gatekeeper's own `issue_comment` trigger) **must** react to
those automation-made merges/comments — which `GITHUB_TOKEN` would suppress. See §7.2b
and §9.6 for the App-token model that replaced the old `MERGE_PAT`.

## Cross-cutting: workflow-parity guard (prevents review from silently breaking)

**Status.** 🟢 Built & verified. **Problem it solves:** §5's guard keys off the
*default branch*, so the instant a workflow change lands on `bridge` without
`staging` being synced, every `staging`-based agent PR skips review — **silently,
with a green check** (the exact failure fixed on 2026-07-10).

**How it works.** A `workflow parity` job in `ci.yml` runs on every PR into
`staging`/`bridge`. For a PR into the **default branch** it passes trivially
(review.yml changes are legitimate there); anywhere else it fails if the merge
result's `review.yml` differs from the default branch's copy:
```
git fetch --no-tags origin "+refs/heads/$DEFAULT:refs/remotes/origin/$DEFAULT"
git diff --quiet "refs/remotes/origin/$DEFAULT" -- .github/workflows/review.yml \
  || { echo "::error::review.yml differs from the default branch — reviews will skip"; exit 1; }
```
It's a **required check on both branches**, so the silent skip is now a loud,
blocking failure. (The explicit refspec avoids a false-positive from
`checkout@v4`'s narrow fetch — a review finding on PR #25.) Verified passing on both
the trivial path (PR into `bridge`) and the real path (a `→ staging` sync PR).

---

## Build order (critical path)

Each item unlocks the next; do them in this order.

1. ~~**Merge PR #18** → CI runs `gradle test`; §4 fully 🟢.~~ **✅ Done** (merged to
   `bridge`, synced to `staging`).
2. ~~**Review verdict** (§5) → `REQUEST_CHANGES`/`APPROVE` + `review-verdict` status.~~
   **✅ Done & verified** (PR #21 on both branches; `review-verdict = success` seen on
   PR #22). Unlocks §6 and §7.
3. ~~**Branch protection** → require `review-verdict`; restrict pushes.~~ **✅ Done** —
   `review-verdict` required on both branches (verified gating #19/#23). Push
   restriction N/A on a user-owned repo. (Also fixed en route: passing reviews post
   `COMMENT`, not `APPROVE`, since the Actions bot can't approve — PR #23.)
4. ~~**Set `MAINTAINER_HANDLE`** + enable "Allow auto-merge".~~ **✅ Done** (variable
   set; auto-merge enabled; no PAT).
5. ~~**Gatekeeper** (§7) → auto-merge on all-green.~~ **✅ Done & verified** — PR #19
   auto-merged into `staging` with zero human action (PR #25). **The happy path now
   closes.**
6. **Fix loop** (§6) — `fixloop.yml` (re-fire + escalate), `resume.yml` (`agent:retry`
   reset), `conflict-watch.yml` conflict-rebase (§6.5), the `agent:retry` label, and the
   FIX-MODE routine-prompt branch are **built and activated** (on `bridge`; live prompt
   pasted). What remains: a live end-to-end run to move §6 from 🟡 to verified.
7. ~~**Workflow-parity guard** → prevents §5 from silently regressing.~~ **✅ Done &
   verified** — `workflow parity` ci job, required on both branches (PR #25).
8. ~~**Release captain** (§8, optional) → drafted notes.~~ **✅ Built** — best-effort
   Haiku `notes` job in `release.yml`, static fallback; unexercised until a real dispatch.
   Auto version-bump also built (seeds from the latest tag).
9. **Alpha soak → promote or fix** (§9) — 🟡 **built pending deploy** (PRs #41 workflows
   + #42 review-skip): soak issue + `soak:pass`/`soak:fail` verdict, PR-based `bridge`
   promotion (stamped verdict, agent review skipped, **no token**), `soak:fail` →
   fix-forward, auto-cut on staging merge, latest-release-on-promotion. Not yet
   live-verified; the soak-freeze refinement (§9.5) is still to build.

After 1–6, the spec's claim holds literally: a labeled issue produces a merged,
tested change with two human touches — write the issue, press ship — and any PR the
agent can't get past review within 3 tries lands on your desk with a full audit
trail instead of merging or silently stalling.
