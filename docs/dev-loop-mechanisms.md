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
| 6 | Fix loop (review → re-fire builder, capped) | `workflow_run` of `review` → `fixloop.yml`; `agent:retry` → `resume.yml`; conflict → `gatekeeper.yml` rebase | `review-verdict` status; `MAX_FIX_ROUNDS`; `agent:needs-human` freeze | 🟡 re-fire + escalate + resume + conflict-rebase built; live-verify pending |
| 7 | Gatekeeper auto-merge | `workflow_run` → arm auto-merge | native auto-merge + required checks | 🟢 verified (#19) |
| 8 | Release (ship button) | `workflow_dispatch` → `release.yml` | manual-only dispatch | 🟢 (no captain notes) |
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
reopened]` for base `staging`/`bridge`. It invokes `anthropics/claude-code-action@v1`
(Opus 4.8, `CLAUDE_CODE_OAUTH_TOKEN`, tools scoped to `Bash(gh:*),Bash(git:*),Write,Read,Grep,Glob`),
reads the diff, and posts a review (summary + inline comments) via
`POST /repos/{repo}/pulls/{n}/reviews`.

**Enforces.** `claude-code-action`'s **workflow-validation guard**: it runs only if
the executing `review.yml` is **byte-identical to the copy on the default branch
(`bridge`)**. This is the anti-prompt-injection defense — a PR can't rewrite the
reviewer to rubber-stamp itself. (This is also why a stale `review.yml` on `staging`
silently skipped reviews until the branches were synced.)

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
§6.1/§6.2), `.github/workflows/resume.yml` (`agent:retry` label → reset budget →
re-fire, §6.3) + the `agent:retry` repo label, and the FIX-MODE branch of the routine
prompt ([build-agent-routine.md](build-agent-routine.md)). **Still to build:** the
gatekeeper's rebase-FIX-MODE on conflict (§6.5), and an end-to-end live verification
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
your commit. If the new review passes (`review-verdict = success`), §7 merges it. A step in
`review.yml` removes `agent:needs-human` whenever it posts a `success` verdict, so
the "stuck" state clears itself the moment the PR is healthy again. (Note: pushes
by *you* re-run review because they are not made with the default `GITHUB_TOKEN`;
see the token note under Branch protection.)

**Resolution in both paths.** The terminal state is identical to any other PR: a
green CI + a `review-verdict = success` → gatekeeper auto-merges to `staging` →
`Closes #N` closes the issue → all `loop:*` / `agent:*` working labels are removed
on merge. Nothing about the escalation leaves residue once resolved.

### 6.4 What must be built for §6

- ✅ `fixloop.yml` (`on: workflow_run` of `review` → read `review-verdict` → round count,
  re-fire, or escalate) — **built.** Uses the built-in `GITHUB_TOKEN`.
- ✅ FIX-MODE branch in the routine prompt (build-agent-routine.md) — **built** (but the
  *live* routine prompt at claude.ai must be re-pasted; the doc edit alone doesn't take).
- ✅ FIX-MODE work-item construction in the fire call — **built** (in `fixloop.yml`,
  shares the §1 `/fire` plumbing).
- ✅ Repo variable `MAINTAINER_HANDLE` (escalation @-mention/assignee) — already set.
- ✅ §5 verdict (hard dependency) — done.
- ✅ `resume.yml` (`on: pull_request` labeled `agent:retry` → delete the `fixloop:refire`
  marker comments to reset the budget → re-fire in FIX MODE) — **built.** Uses `GITHUB_TOKEN`.
- ✅ A repo label `agent:retry` (maintainer-applied resume trigger) — **created.**
- ✅ **Conflict → rebase FIX MODE** — **built** in `gatekeeper.yml` (§6.5): on an
  otherwise-green but `CONFLICTING` PR it re-fires FIX MODE with a rebase instruction,
  sharing the `<!-- fixloop:refire -->` marker + `MAX_FIX_ROUNDS` budget, and freezes
  (`agent:needs-human`) if the conflict outlives the budget.
- 🔲 Live end-to-end verification against a real change-request.
- **No `GATEKEEPER_TOKEN` / PAT** — the `workflow_run` trigger (§6.1) sidesteps the
  recursion guard, and the re-fire happens through the routine (the `app/claude`
  App pushes, which already re-triggers CI/review). So the whole loop runs on the
  built-in `GITHUB_TOKEN` + the existing `ROUTINE_FIRE_TOKEN`.

### 6.5 · Merge conflicts — nothing force-merges; it stalls, then rebases

A `claude/*` PR that conflicts with `staging` is `mergeable: false` /
`mergeStateStatus: DIRTY`. **GitHub's native auto-merge refuses a conflicted PR and
disables itself**, so a conflict *never* produces a bad merge — the PR simply
stalls. Handling:

- When the gatekeeper (§7) evaluates an otherwise-green PR and finds it `DIRTY`, it
  does **not** merge. Instead it re-fires the builder in **FIX MODE with a rebase
  instruction**: *"merge `origin/staging` into `claude/<slug>`, resolve the
  conflicts, push — do not open a new PR."* This reuses the §6.1 re-fire path.
- The push emits `synchronize` → CI + review re-run on the resolved tree → a fresh
  verdict, exactly like a normal fix round.
- It counts against the **same `MAX_FIX_ROUNDS` cap** and escalates via §6.2 (the
  `agent:needs-human` flow) if the agent can't resolve the conflict within budget —
  so a genuinely hard conflict lands on your desk instead of looping forever.

**Status.** 🟢 Built in `gatekeeper.yml`. When the gate evaluates an
otherwise-green PR (`review-verdict = success`) whose `mergeable = CONFLICTING`, it
re-fires FIX MODE with the rebase instruction above, marks the attempt with the shared
`<!-- fixloop:refire -->` marker (so review-fix and rebase rounds share the one
`MAX_FIX_ROUNDS` budget), and — once the budget is spent on a still-conflicting PR —
freezes it with `agent:needs-human` + a maintainer @-mention. **Known limitation:** the
gate fires on the PR's own `ci`/`review` completion, so a PR that goes `CONFLICTING`
only because `staging` advanced *after* it was armed isn't re-evaluated until its own
checks next run; native auto-merge disables itself on the conflict, so it stalls
(safely) rather than mis-merging.

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
- **Trigger.** `on: workflow_run` completion of `ci` + `review`. Guard: same-repo,
  PR head `claude/*` (base `staging`).
- **Gate.** Merge only if **all** hold: both `ci` job contexts = `success`, the
  `review-verdict` context = `success`, and no `agent:needs-human` label present.
- **Action.** `gh pr merge {n} --squash --auto` using the built-in `GITHUB_TOKEN`.
  `--auto` hands off to *native* auto-merge, so branch protection itself does the
  final "wait for green" — the job just arms it. (In this repo `GITHUB_TOKEN` can
  merge: 0 required approvals, no push restrictions; and the staging merge doesn't
  need to trigger anything downstream, so the recursion guard is a non-issue.)
- **On verdict = failure** it does nothing; §6 owns that path.
- **On conflict (`DIRTY`)** it does not merge; it re-fires the rebase FIX MODE (§6.5).
- **Prerequisites.** Enable the repo's **"Allow auto-merge"** setting (a repo toggle,
  not a token). **No `GATEKEEPER_TOKEN` needed.** If you later add automation that
  must react to the staging merge (e.g. an auto-promotion `staging → bridge`), *that*
  is when a non-default token becomes necessary — not before.

---

## 8 · Release — the human ship button

**Drives.** `.github/workflows/release.yml` runs **only** `on: workflow_dispatch`
(input `channel: alpha|beta`). On a `windows-latest` runner it builds `bridge.jar`
(Gradle 7.4.2), installs overlay deps, `npm run build` + `electron-builder --win
--x64`, reads `overlay/package.json` version, and `gh release create v$VERSION
--prerelease` with the installer + jar as assets.

**Enforces.** The manual-dispatch-only trigger *is* the release gate — nothing
publishes without a human pressing it, which encodes the never-release-without-an-
explicit-ask rule. Version is read from `overlay/package.json` (single source of
truth), bumped by a human before dispatch, so a dispatch can't silently re-version.

**Status.** 🟢 Built. Two optional pieces are TODO in the file:

**To-build (optional).**
- **Release-notes "captain".** A preceding job runs a Haiku agent over the
  Conventional Commits since the last tag to draft notes, wired into `gh release
  create --notes-file`. Today notes are static (`"Automated {channel} build from
  {ref}"`). Model per spec §04: `claude-haiku-4-5`, low effort.
- **Auto version-bump** before tagging (kept manual by design for now).

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
  `gh pr merge <n> --admin --squash -R hotmalehotmail/RealmShark`. The UI equivalent
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
| ~~`GATEKEEPER_TOKEN`~~ | **Not needed** — see below | — |

**No `GATEKEEPER_TOKEN` (why the earlier plan dropped it).** GitHub's recursion
guard means actions taken with the built-in `GITHUB_TOKEN` don't trigger further
workflows. The *only* place that bit this design was the fix-loop trigger: if it
keyed on the reviewer's `pull_request_review`, that review is posted with
`GITHUB_TOKEN`, so the event would be suppressed. **We chose the `workflow_run`
trigger (§6.1) instead** — it fires regardless of token — so nothing in §6/§7 needs
elevated credentials. The gatekeeper's merge runs on `GITHUB_TOKEN` (0 required
approvals, no push restrictions, and the staging merge doesn't cascade). A
non-default token (PAT/App) only becomes necessary if you later add automation that
must react to an automation-made merge or push — none exists today.

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
   reset), `gatekeeper.yml` conflict-rebase (§6.5), the `agent:retry` label, and the
   FIX-MODE routine-prompt branch are **built and activated** (on `bridge`; live prompt
   pasted). What remains: a live end-to-end run to move §6 from 🟡 to verified.
7. ~~**Workflow-parity guard** → prevents §5 from silently regressing.~~ **✅ Done &
   verified** — `workflow parity` ci job, required on both branches (PR #25).
8. **Release captain** (§8, optional) → drafted notes.

After 1–6, the spec's claim holds literally: a labeled issue produces a merged,
tested change with two human touches — write the issue, press ship — and any PR the
agent can't get past review within 3 tries lands on your desk with a full audit
trail instead of merging or silently stalling.
