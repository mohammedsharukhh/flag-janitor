# Flag Janitor

Feature flags are easy to add and nobody removes them. Flagsmith already tells you a flag is **stale**.
Flag Janitor does the boring part: it **deletes the flag from your code**, runs your tests, opens a PR,
and once that PR merges it **archives the flag in Flagsmith**.

```
Flagsmith: "new_checkout is stale, ON for everyone in Production"
        │
        ▼
flag-janitor run ──► rewrites code (keeps the live branch, deletes the dead one)
                 ──► runs your tests ──► opens PR "Remove stale flag new_checkout"
        │
   you merge
        ▼
flag-janitor archive ──► checks no code still mentions the flag ──► archives it in Flagsmith
```

Built for the self-hosted Flagsmith track: everything talks to your own Flagsmith instance.

## What the rewrite looks like

```diff
-  if (flags.isFeatureEnabled('new_checkout')) {
-    return subtotal >= 50 ? subtotal : subtotal + 5;
-  } else {
-    return subtotal + 7;
-  }
+  return subtotal >= 50 ? subtotal : subtotal + 5;

-  const useNewCheckout = flags.isFeatureEnabled('new_checkout');
-  return useNewCheckout ? 'Pay now' : 'Proceed to checkout';
+  return 'Pay now';

-      {flagsmith.hasFeature('holiday_banner') && <HolidayBanner />}
```

It is a real AST codemod (jscodeshift), not find-and-replace. It handles `if/else`, `else if`, `!`, `&&`, `||`,
ternaries, `await`, `const x = hasFeature(...)` and JSX children, for JS, TS, JSX and TSX.

## How it uses Flagsmith

| Flagsmith piece | Used for |
|---|---|
| **Stale tag** (system tag or a `stale` tag) | which flags to remove |
| **Production environment state** | whether to keep the ON or the OFF branch |
| **Segment / identity overrides, multivariate** | safety: a flag that isn't one value for everyone is skipped |
| **Admin API, archive** | archive the flag after the cleanup PR merges |
| **flagsmith-nodejs SDK, its own flags** | dogfooding: `open_prs` and `archive_flags` flags switch the janitor's own risky actions on/off |

Turn `open_prs` off in Flagsmith and the janitor only prints diffs. No redeploy, no config change.

## Safety rules

- Skips flags with segment overrides, identity overrides or multiple variants.
- Never opens a PR if your tests fail.
- Never archives a flag while any code still mentions it (catches `getValue('x')`, config, anything the codemod didn't rewrite).
- Refuses to run on a dirty git tree. One PR per flag; won't open a duplicate.

## Security

Flag Janitor runs inside your CI with an admin key, so it is built to fail safe. Each rule has a test.

| Threat | What Flag Janitor does |
|---|---|
| A malicious PR branch name (`flag-janitor/remove-<anything>`) tries to archive a live flag | Archives only flags Flagsmith still tags **stale**, only when no tracked file mentions them, and only plain names (`[A-Za-z0-9_.-]`, no leading `-`, no `..`) |
| A flag still used in YAML/JSON/Python config gets archived and breaks a deploy | The archive check scans every tracked file as a whole word, not just JS |
| Your test suite (arbitrary code) steals credentials | Tests run with `FLAGSMITH_API_KEY`, `GH_TOKEN`, `GITHUB_TOKEN` and the gate key stripped from the environment |
| A pagination link points to another host and receives the admin key | Only the path of `next` is used; requests always go to your configured Flagsmith |
| A symlink or git-ignored file makes the janitor write outside the repo or leave changes behind | Only tracked, non-symlink files are rewritten |
| Flagsmith is down and the gate can't be read | Gate fails **closed**: no PRs, no archiving |
| Shell injection through flag names or branch names | No shell: every git/gh call passes arguments as an array; Action inputs go through `env` |
| A human closes a cleanup PR, then gets it again every week | A closed-unmerged PR for that flag means skip |
| Uncommitted local work gets lost | Refuses to run on a dirty tree |
| A third-party Action tag gets hijacked | `actions/setup-node` is pinned to a commit SHA; `npm ci` uses the lockfile |

## Tests

```bash
npm test            # 30 tests: codemod, repo safety, Flagsmith client, CLI end-to-end (real git + fake Flagsmith + fake gh)
npm run test:live   # read-only checks against your self-hosted Flagsmith (uses .env)
```

## Use it

### GitHub Action

```yaml
- uses: actions/checkout@v4
- uses: mohammedsharukhh/flag-janitor@main
  with:
    flagsmith-api-url: https://flagsmith.example.com/api/v1
    flagsmith-api-key: ${{ secrets.FLAGSMITH_API_KEY }}       # Admin API key
    flagsmith-environment: ${{ vars.FLAGSMITH_ENVIRONMENT }}  # Production env key
```

Full workflow (weekly cleanup + archive on merge): [demo-shop workflow](https://github.com/mohammedsharukhh/flag-janitor-demo-shop/blob/main/.github/workflows/flag-janitor.yml).
If your Flagsmith is only reachable on your network, use a [self-hosted runner](https://docs.github.com/actions/hosting-your-own-runners).

### CLI

```bash
npm install
export FLAGSMITH_API_URL=http://localhost:8000/api/v1
export FLAGSMITH_API_KEY=...            # Organisation settings → API Keys (admin)
export FLAGSMITH_ENVIRONMENT=...        # Production environment key
export JANITOR_ENVIRONMENT_KEY=...      # optional: env with open_prs / archive_flags flags

node src/cli.js scan --dir ../my-app            # what would be removed
node src/cli.js run --dry-run --dir ../my-app   # show the diffs
node src/cli.js run --dir ../my-app             # open the PRs (needs gh auth)
node src/cli.js archive new_checkout --dir ../my-app
```

## Run self-hosted Flagsmith locally

```bash
docker compose -f flagsmith/docker-compose.yml up -d   # UI + API on http://localhost:8000
```

## Limits

- JS/TS only. Recognises `hasFeature('x')` and `isFeatureEnabled('x')` with a literal flag name.
- Leaves now-unused variables/imports for your linter to flag.
- Two flags in the same file give two PRs that may conflict; the next run rebases from main.

MIT licence.
