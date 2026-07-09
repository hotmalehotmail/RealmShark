# Automatic doc sync

A git `post-commit` hook that, whenever a commit touches source code, runs a
headless Claude agent to update any project docs the change made stale — and
auto-commits just those doc edits.

## Pieces

| File | Role |
|------|------|
| `.git/hooks/post-commit` | Thin, always-`exit 0` trigger. Backgrounds the worker so `git commit` returns instantly, and strips the git env vars git sets for hooks so the worker's own git runs against the real repo. **Not tracked** — lives only in your local `.git/`. |
| `scripts/doc-sync.sh` | All the logic and guards. Tracked, so it is versioned and reviewable. |
| `.git/doc-sync.log` | Every run appends here. First place to look. |

## What actually runs

The worker invokes `claude -p` (model `sonnet`, for cost) with a tightly-scoped
prompt: read the commit diff, judge conservatively whether anything documented
under `docs/` or in `CLAUDE.md` is now wrong, make the minimal edits, and commit
only those doc files. Tool access is allowlisted to `Read/Grep/Glob/Edit/Write`
plus a handful of read-only + commit git commands — it cannot push, amend, or
edit source.

## Guards (why it won't loop or trash your tree)

- **Recursion:** the auto-commit's subject carries a `[doc-sync]` marker; the
  worker skips any commit whose message contains it. Belt-and-suspenders: it
  only fires when `src/` or `overlay/src/` changed, so a docs-only commit (which
  is all the auto-commit ever is) can't retrigger it either.
- **Dirty tree:** skips if there are uncommitted *tracked* changes, so it can
  never sweep your work-in-progress into a commit. (Untracked files are ignored.)
- **In-flight ops:** skips during rebase / merge / cherry-pick / bisect.
- **Single-flight:** an atomic `mkdir` lock; a lock older than 30 min is
  reclaimed (covers a hard-killed run).
- **Watchdog:** the agent run is capped at 900 s if `timeout`/`gtimeout` is on
  PATH (`brew install coreutils` provides `gtimeout`); otherwise the stale-lock
  reclaim is the backstop.

## Toggle

```bash
git config doc-sync.enabled false   # off
git config doc-sync.enabled true    # on (default)
```

Or remove the trigger entirely: `chmod -x .git/hooks/post-commit`.

## Test it without spending an agent run

```bash
DOC_SYNC_DRYRUN=1 scripts/doc-sync.sh <commit-sha>   # runs every guard, logs, then stops
tail -f .git/doc-sync.log
```

## Notes / limits

- The hook is **local to this clone** — it isn't shared by cloning. To share it,
  move it to a tracked dir and `git config core.hooksPath <dir>`.
- The doc-sync commit lands a few seconds *after* yours, asynchronously in the
  background — don't be surprised by an extra commit appearing.
- It runs an agent on **every** code-touching commit; that has a token cost.
  Flip `doc-sync.enabled` off if you're doing a rapid commit burst.
