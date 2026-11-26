# Leftovers the codemod does not rewrite

`flag-janitor rewrite` handles `hasFeature('x')` / `isFeatureEnabled('x')` with a literal name: if/else, else-if, `!`,
`&&`, `||`, ternaries, `await`, `const x = …` and JSX children. Everything else it lists as
`still mentions <flag> (fix by hand)`. Fix each by hand, keeping production behaviour (the on/off value from step 1).

| Leftover | Fix |
|---|---|
| `getValue('x')` / remote config read | Replace with the production value. Ask the user if the value isn't obvious. |
| Config: `x: true` in YAML/JSON/env | Delete the entry. If code reads it, apply the same on/off value there. |
| Test mocks: `isFeatureEnabled: (n) => n === 'x'` | Delete the case for `x`; delete tests that only cover the removed branch. |
| Flag name in a constant: `const FLAG = 'x'; hasFeature(FLAG)` | Inline the value (`true`/`false`) at each use, then delete the constant. |
| Other languages (Python, Go, …) | Same idea by hand: keep the branch for the production value, delete the other. |
| Docs, CHANGELOG | Leave history alone. Update docs that describe the flag as a toggle. |

After fixing: `git grep -n -w -F <flag> -- . ':(exclude)*.md'` must print nothing, then run the tests.
