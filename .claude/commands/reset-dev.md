---
description: Reset dev to main after a squash-merge promotion (aborts if dev has unpromoted work)
---

# Reset dev to main

After a dev → main promotion PR is squash-merged, dev must be hard-reset to main so the two histories stay shared. This command performs that reset safely.

## Steps

1. **Fetch fresh refs**: `git fetch origin --prune`

2. **Safety check — is anything new lingering on dev?**
   - `git diff --stat origin/main origin/dev` — if **empty**, dev's content is fully contained in main and the reset is safe; skip to step 3.
   - If non-empty, run `git cherry origin/main origin/dev` and `git log --oneline origin/main..origin/dev` to identify commits on dev whose *content* is not in main (lines prefixed `+` in cherry output).
   - **STOP and report to the user** if any unpromoted content exists. List the lingering commits and ask whether to (a) promote them first via a dev → main PR, or (b) discard them deliberately. Do NOT force-push in this state without explicit confirmation.

3. **Capture the old dev tip** (needed for rebasing open PRs): `OLD_DEV=$(git rev-parse origin/dev)`

4. **Reset dev to main**:
   ```bash
   git push origin +refs/remotes/origin/main:refs/heads/dev
   ```
   This requires repo-admin bypass on the "Guardrail Dev" ruleset. If the push is rejected, tell the user to check the ruleset's bypass list (Settings → Rules → Guardrail Dev).

5. **Re-point open PRs based on dev**: `gh pr list --base dev --json number,headRefName,author`
   - Dependabot PRs: comment `@dependabot rebase` on each.
   - Human PRs: rebase with `git rebase --onto origin/dev $OLD_DEV <branch>` and force-push with `--force-with-lease` (confirm with the branch owner if it isn't the current user's branch).

6. **Verify**:
   - `git merge-base origin/main origin/dev` equals `git rev-parse origin/main`
   - `git rev-list --count origin/main...origin/dev` is `0	0`

Report what was reset, the old/new dev SHAs, and which PRs were rebased or pinged.
