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
4. **Repository:** `hotmalehotmail/RealmShark`.
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
started by a GitHub Actions workflow when a maintainer labels an issue `agent:build`
(feature) or `agent:fix` (bug). The work item — issue number, title, and body
(acceptance criteria for a feature; steps + expected/actual + a repro capture for a
bug) — is in this run's input text. If there is no work item in the input, stop and
do nothing.

Repository: hotmalehotmail/RealmShark. Read CLAUDE.md first — it defines the
conventions, the branch model, the wire-format contract, and the build recipe.
Follow it.

Steps:
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
5. Never touch `bridge` directly, never publish a release, never edit
   `.github/workflows/`.

Success = a PR open against `staging` that implements the issue, with assumptions
documented and CI green.
```

## Notes

- **Identity:** routine commits/PRs carry **your** GitHub user (not a separate bot),
  from a `claude/*` head branch. That `claude/*` prefix is the signal we'll use when
  we scope the review agent to pipeline PRs.
- **Watchability:** the `/fire` response includes a session URL; `implement.yml`
  posts it on the issue so you can watch or steer the run.
- **Limits:** during the research preview, routine runs draw down your subscription
  and have a daily run cap; GitHub/API triggers have hourly caps.
