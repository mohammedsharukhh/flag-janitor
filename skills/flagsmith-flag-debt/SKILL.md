---
name: flagsmith-flag-debt
description: Pay off Flagsmith flag debt end to end. Finds feature flags tagged stale, deletes them from the code keeping the branch production uses, runs the tests, opens one pull request per flag, and archives the flag in Flagsmith once the PR is merged. Use when asked to clean up stale, old, unused or permanent feature flags, remove flag checks from code, or archive Flagsmith flags. Works with Flagsmith Cloud and self-hosted Flagsmith; automatic rewrite for JS/TS/JSX/TSX.
license: MIT
compatibility: Needs the Flagsmith CLI v2 (flagsmith), git, Node.js 18+, and gh for pull requests. Flagsmith Admin API key or `flagsmith login`.
metadata:
  repository: https://github.com/mohammedsharukhh/flag-janitor
  version: "1.0"
---

# Flagsmith flag debt

Goal: for every flag Flagsmith tags **stale**, the code no longer checks it, tests pass, a PR is open, and after merge the
flag is archived. Two production-touching moments (push/PR, archive) need the user's **yes**.

Keep output small: use the scripts below, `--jq`, and `git diff --stat`. Never paste whole files or full JSON.

## 0. Check the setup (once)

```sh
flagsmith --version                 # v2.x. Install: brew install Flagsmith/tap/flagsmith  or  npm i -g @flagsmith/cli
flagsmith config                    # API URL + environment resolved?
git status --porcelain              # must be empty: never mix the cleanup with the user's own changes
```

- `FLAGSMITH_ENVIRONMENT` must be the key of the environment whose values win (normally **Production**). Ask if unsure.
- Self-hosted: `FLAGSMITH_API_URL=https://flagsmith.example.com` (no `/api/v1`). The CLI only sends a key to the host it
  belongs to: for a non-default host set `FLAGSMITH_API_KEY_<host>_<port>` (the CLI's error message prints the exact name).

## 1. Find the stale flags

```sh
node scripts/find-stale.mjs
```

Prints one line per stale flag (read-only, Flagsmith CLI only):

- `old_search on` → remove it, keep the code path for **ON**
- `holiday_banner off` → remove it, keep the code path for **OFF**
- `beta skip segment overrides` → **do not touch** (also: identity overrides, multivariate, unsafe name). Report it.

Nothing printed means nothing to do. Stop.

## 2. For each removable flag: rewrite, test, review

```sh
git switch -c flag-debt/remove-<flag>
npx -y "$JANITOR" rewrite <flag> on|off    # AST codemod, deterministic, offline
```

`JANITOR=https://codeload.github.com/mohammedsharukhh/flag-janitor/tar.gz/c87748f83f787fc20d380de5dcad91eb45e0c07f`
(pinned to a commit, so the code you run is the code that was reviewed).

It prints `rewrote N file(s): …` and, if anything is left, `still mentions <flag> (fix by hand): …`.
Fix those leftovers yourself (config entries, `getValue`, test mocks, docs): see
[references/manual-fixes.md](references/manual-fixes.md). Then:

```sh
git grep -n -w -F <flag> -- . ':(exclude)*.md'   # must print nothing (except a CHANGELOG you chose to keep)
npm test                                         # or the repo's own test command; must pass
git diff --stat
```

If tests fail: show the failure, `git switch - && git branch -D flag-debt/remove-<flag>`, move on. **Never open a PR
with failing tests.** Unused imports or variables left behind: remove them only if the linter or tests complain.

## 3. Open the PR (ask first)

Show the user: flag, kept branch (on/off), `git diff --stat`, test result. Ask: *"Push and open the PR?"* Only on yes:

```sh
git commit -am "chore: remove stale flag <flag>"
git push -u origin flag-debt/remove-<flag>
gh pr create --title "Remove stale flag <flag>" --body "Flagsmith marks <flag> stale; it is <ON|OFF> for everyone in production. This hard-codes that value and deletes the dead branch. Tests pass. Archive the flag after merge."
```

One flag per PR. Check first, before step 2 even: `gh pr list --state all --search '"<flag>" in:title' --json number,state`
must be empty. An open PR means someone is on it; a closed one means a human said no. Skip both.

## 4. After the PR is merged: archive (ask first)

Archive only when **all** are true:

1. `gh pr view <n> --json state --jq .state` is `MERGED`.
2. `git fetch -q && git grep -w -F <flag> origin/HEAD -- . ':(exclude)*.md'` prints nothing.
3. `node scripts/find-stale.mjs` still prints `<flag> on|off` with the **same** value the PR kept. A changed value or a
   new override means production behaviour moved: stop and tell the user.

Ask: *"Archive <flag> in Flagsmith?"* Only on yes:

```sh
P=$(flagsmith api "api/v1/environments/$FLAGSMITH_ENVIRONMENT/" --jq .project)
flagsmith feature update <flag> --archive -p "$P" --no-input
```

Archiving is reversible (`--unarchive`). Never `feature delete`.

## 5. Report

One line per flag: `removed + PR #n`, `archived`, `skipped: <reason>`, or `failed: <why>`. Nothing else.

## Rules

- Production changes happen only through steps 3 and 4, each after an explicit yes.
- Never touch flags `find-stale.mjs` marks `skip`, flags without the stale tag, or other environments' values.
- Never print or commit API keys. Tests run with the normal environment: do not export the admin key into it.
- Flag names come from Flagsmith: pass them as single quoted arguments, never build shell strings from them.
