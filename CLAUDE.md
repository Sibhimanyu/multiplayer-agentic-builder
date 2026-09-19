## gstack (REQUIRED — global install)

**Before doing ANY work, verify gstack is installed:**

```bash
_GS=""
for _D in "${GSTACK_ROOT:-}" "$HOME/.claude/skills/gstack" "$HOME/.codex/skills/gstack" "$HOME/.factory/skills/gstack" "$HOME/.kiro/skills/gstack" "$HOME/.config/opencode/skills/gstack" "$HOME/.slate/skills/gstack" "$HOME/.cursor/skills/gstack" "$HOME/.openclaw/skills/gstack" "$HOME/.hermes/skills/gstack" "$HOME/.gbrain/skills/gstack" "$HOME/.gstack/repos/gstack"; do
  [ -z "$_GS" ] && [ -n "$_D" ] && [ -d "$_D/bin" ] && _GS="$_D"
done
[ -n "$_GS" ] && echo "GSTACK_OK: $_GS" || echo "GSTACK_MISSING"
```

If GSTACK_MISSING: STOP. Do not proceed. Tell the user:

> gstack is required for all AI-assisted work in this repo.
> Install it:
> ```bash
> git clone --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack
> cd ~/.claude/skills/gstack && ./setup --team
> ```
> Then restart your AI coding tool.

Do not skip skills, ignore gstack errors, or work around missing gstack.

Using gstack skills: After install, skills like /qa, /ship, /review, /investigate,
and /browse are available. Use /browse for all web browsing (Aside first, the bundled gstack browser as fallback).
Use the resolved install path above for gstack file paths
(default: ~/.claude/skills/gstack).

## Testing

```bash
npm test               # seconds, no emulator — run this constantly
npm run typecheck:all  # all four packages, not just the root
npm run test:emulator  # minutes, needs a JDK 21+ and firebase-tools
npm run test:all       # everything, same as CI
```

Full detail, and the reasoning behind the suite layout, is in **TESTING.md**. The parts that bite:

- `npm run typecheck` alone covers `shared/` and `cli/` only. The root and `functions/` use
  different settings, which is how `functions/` carried two real type errors for weeks while the
  root stayed green. Use `typecheck:all`.
- The four emulator groups run in **four separate emulator processes** on purpose. Batching them
  makes the conformance suite fail at 106 s with `Transaction lock timeout` — accumulated
  emulator degradation, not an adapter defect. Do not merge them to save startup time.
- Outside `firebase/`, import the admin SDK through `firebase/admin-sdk.ts`, never as a bare
  `firebase-admin` specifier. Three copies are installed and two module instances make
  `FieldValue` sentinels fail an `instanceof`, which surfaces as an unrelated-looking 502.
- New test file? It must be reachable from an npm script, or `cli/every-test-runs.test.ts` fails.
  That guard exists because 11 of 22 test files were running.
- `test:stress` (`32 concurrent appends ALL land`) currently fails ~2 runs in 3, in isolation,
  with `Transaction lock timeout`. Unresolved, not a known-good flake: it is either emulator
  saturation or a genuinely marginal 6-attempt retry budget, and settling it needs a run against
  real Firestore. Do NOT raise the retry budget to make it green -- that is a production
  parameter. See TESTING.md.

When adding code: a new function gets a test, a bug fix gets a regression test that fails without
the fix, and a new conditional gets both branches. Any test that scans or derives needs a control
assertion proving the scan found something — a scan that matches nothing passes silently.
