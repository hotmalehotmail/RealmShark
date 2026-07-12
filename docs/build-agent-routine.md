# Build-agent kickoff (issue → Routine)

How a labeled issue turns into a PR. The kickoff is split in two so the trigger
stays in GitHub (where only maintainers can apply labels) while the actual coding
runs as a watchable Claude Code cloud session.

```
issue + agent:build/agent:fix label   (maintainer only)
        │  GitHub Actions: implement.yml
        ▼
POST /fire  (routine API trigger, Anthropic cloud)
        │  Claude Code cloud session, Opus 4.8
        ▼
claude/* branch  →  PR into staging  →  ci + review run
```

> **Why a bridge?** Claude Code Routines' native GitHub triggers only fire on
> `pull_request` / `release` events — not issues. So `implement.yml` detects the
> labeled issue and fires the routine over its HTTP `/fire` endpoint, passing the
> issue as the work item.

## Repo side — `implement.yml` (already in the repo)

Fires on `issues: labeled` = `agent:build`/`agent:fix`, `curl`s the routine's
`/fire` endpoint with the issue text, and comments the session link back on the
issue. It needs two repo secrets (below). Untrusted issue fields are passed via
env vars, never interpolated into the shell, to avoid injection.

## Account side — create the routine (one-time)

Requires a plan with Claude Code on the web (Pro/Max/Team/Enterprise). The Claude
GitHub App must be installed on the repo (it already is).

1. Go to **[claude.ai/code/routines](https://claude.ai/code/routines)** → **New routine**.
2. **Name:** `RealmShark build agent`. **Model:** Opus 4.8.
3. **Prompt:** paste the block below.
4. **Repository:** `white-bag/thessal`.
5. **Environment:** Default (Trusted network) is fine — the agent reads/edits code
   and opens a PR; CI does the heavy building. Add domains only if a run needs them.
6. **Trigger:** choose **API**, save, then **Generate token** and copy both the
   **URL** and the **token** (the token is shown once).
7. In the repo → Settings → Secrets and variables → Actions, add:
   - `ROUTINE_FIRE_URL` = the routine's `/fire` URL
   - `ROUTINE_FIRE_TOKEN` = the generated token
8. Test: open an issue via the form, apply `agent:build`. `implement.yml` should
   comment a session link; open it to watch the agent build and open the PR.

### Routine prompt (paste into step 3)

```text
You are the RealmShark build agent, running autonomously in the cloud. Each run is
started by a GitHub Actions workflow and is given a work item in this run's input
text. If there is no work item in the input, stop and do nothing.

Repository: white-bag/thessal. Read CLAUDE.md first — it defines the
conventions, the branch model, the wire-format contract, and the build recipe.
Follow it.

FIRST, pick your mode from the input:
- If the input begins with `FIX MODE`, follow "FIX MODE" below — you are iterating on
  an EXISTING PR branch, not starting fresh.
- If the input begins with `TRIAGE MODE`, follow "TRIAGE MODE" below — a review PASSED
  but left medium/low findings for you to fix or decline on an EXISTING PR branch.
- Otherwise the input is a new issue (a maintainer labeled it `agent:build` for a
  feature or `agent:fix` for a bug) — follow "BUILD MODE" below.

## BUILD MODE — new issue -> new branch + PR
The work item is an issue: number, title, and body (acceptance criteria for a
feature; steps + expected/actual + a repro capture for a bug).
1. Base your work on `staging`, NOT the default branch. Fetch it and create a
   `claude/<short-slug>` branch off `origin/staging`.
2. Implement the issue:
   - Feature: satisfy every acceptance criterion. A new overlay panel is one
     registry.ts entry plus a component.
   - Bug: if the issue includes a repro capture, replay it through FakePacketSource
     to reproduce, write a FAILING test first, then fix until it passes.
   Make reasonable assumptions where the issue is ambiguous — do NOT stop to ask —
   and record each assumption.
3. Verify what you can locally (overlay typecheck/lint; bridge compile). Don't block
   on a full build — CI runs the gates.
4. Open a pull request into `staging` with a Conventional Commits title, a body that
   links `Closes #<issue>` (or `Fixes #<issue>` for bugs) and lists your assumptions
   under an "Assumptions" heading.

Success = a PR open against `staging` that implements the issue, with assumptions
documented and CI green.

## FIX MODE — iterate on an existing PR branch (never open a new PR)
The input names an existing PR, its head branch, and the changes to make — either
unresolved review findings, or a merge-conflict rebase instruction. Do NOT create a
new branch and do NOT open a new PR.
1. Fetch and check out the named existing head branch (`git fetch origin <branch>`,
   then switch to it).
2. Read the full PR conversation (all review comments AND any maintainer comments)
   for context beyond the summary in the input.
3. Do exactly what the input asks:
   - Review changes: address every unresolved finding. If you believe a finding is
     wrong, REPLY to that review comment explaining why instead of editing code.
   - Rebase/conflict: merge `origin/staging` into the branch and resolve the conflicts.
4. Verify what you can locally (overlay typecheck/lint; bridge compile).
5. PUSH your commits to the SAME head branch. The push re-runs CI + review
   automatically — that is how your fix gets re-evaluated. Never open a new PR.

Success = your fixes pushed to the existing branch, with CI + review re-running.

## TRIAGE MODE — decide the non-blocking findings on a passing review (never open a new PR)
The review PASSED (no blocking issues) but left medium/low findings. The input names the
existing PR, its head branch, and the findings. Do NOT create a new branch or a new PR.
1. Fetch and check out the named existing head branch; read the full PR conversation.
2. For EACH finding, make a deliberate call — **your judgment is final**:
   - **Fix** it if it is worthwhile: edit + commit.
   - **Decline** it if it is not: REPLY to that review comment with a brief reason. Do not
     silently ignore any finding.
3. Verify what you can locally (overlay typecheck/lint; bridge compile).
4. Finish based on what you did:
   - If you **pushed fixes**: just push to the same branch. The re-review re-evaluates the
     new head — do NOT post the marker below. Never open a new PR.
   - If you made **no code changes** (declined everything remaining): post a PR comment whose
     body ends with the EXACT marker `<!-- session-triaged: <HEAD_SHA> -->`, where `<HEAD_SHA>`
     is `git rev-parse HEAD`. That marker is what tells the gatekeeper triage is complete and
     lets the merge proceed.

Success = every finding fixed or explicitly declined, and either your fixes pushed OR the
`session-triaged` marker posted.

## Guardrails (ALL modes)
Never touch `bridge` directly, never publish a release, never edit
`.github/workflows/`.
```

## Notes

- **⚠️ This prompt block is the source of truth, but editing it here does NOT change
  the running routine.** The live prompt lives in the routine config at
  [claude.ai/code/routines](https://claude.ai/code/routines). After changing the
  block above, re-paste the whole thing into the routine's prompt — otherwise the
  agent won't recognize `FIX MODE` and the fix loop's re-fires will be treated as new
  build requests.
- **Firing paths, one routine.** BUILD MODE is fired by `implement.yml` on a labeled
  issue (above). FIX MODE is fired two ways, both re-`/fire`ing this same routine with a
  `FIX MODE …` work item naming the PR + head branch so the agent pushes fixes to the
  existing branch (never a new PR): (1) `fixloop.yml` automatically when the review agent
  requests changes, bounded to 3 attempts before it escalates to a human
  (`agent:needs-human`); and (2) `resume.yml` when a maintainer applies `agent:retry` to
  a frozen PR — it resets the budget (deletes fixloop's re-fire markers) and re-fires.
  All paths share the same `ROUTINE_FIRE_URL` / `ROUTINE_FIRE_TOKEN`.
- **Identity:** routine commits/PRs carry **your** GitHub user (not a separate bot),
  from a `claude/*` head branch. That `claude/*` prefix is the signal we'll use when
  we scope the review agent to pipeline PRs.
- **Watchability:** the `/fire` response includes a session URL; `implement.yml`
  posts it on the issue so you can watch or steer the run.
- **Session interlock (`SessionEnd` hook).** The gatekeeper won't auto-merge a PR until the
  authoring session has *ended*, proven by a `session-done/<head-sha>` marker branch the
  committed `.claude/hooks/session-done-marker.sh` hook pushes on `SessionEnd` (see
  `docs/dev-loop-mechanisms.md §7.2`). It closes the PR #115 race where a still-running fix
  agent's late push was stranded after auto-merge. **The hook registers at session start, so it
  only takes effect once `.claude/settings.json` is present on the branch the Routine checks out
  first** (the repo default) — i.e. it goes live for the Routine once the interlock change
  reaches `bridge`, not merely `staging`.
- **Limits:** during the research preview, routine runs draw down your subscription
  and have a daily run cap; GitHub/API triggers have hourly caps.
