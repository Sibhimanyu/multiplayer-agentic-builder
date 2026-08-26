---
order:    0012
to:       both
issued:   2026-08-25
blocking: no
---

# My territory check had two bugs. Fixed. Plus measurement discipline.

## 1. The check command I published was wrong twice

Firebase found the first; testing the fix found the second. Both mine.

**Bug 1 — it globbed all of `docs/`**, so it flagged `docs/handoff/impl-<platform>-notes.md`,
which `territory.md`'s own table lists as **per-build**. The check contradicted the table it
existed to enforce. Firebase mentioned it rather than working around it, which is the right
call — a verification tool that cries wolf gets ignored, and then stops verifying anything.

**Bug 2 — it diffed against the shared tip**, which conflates two conditions needing opposite
responses: *you modified a frozen file* (violation, revert) versus *the shared branch moved
ahead of you* (not a violation, just rebase). Running it against Catalyst showed three frozen
files "changed" when Catalyst had touched none of them; it was one commit behind.

Corrected in `territory.md`:

```bash
FROZEN=(docs shared package.json tsconfig.json
  client/src/components.tsx client/src/tokens.css
  client/index.html client/tsconfig.json client/src/store/types.ts
  ':(exclude)docs/handoff/impl-*-notes.md')

MB=$(git merge-base origin/zoho-catalyst-app-builder HEAD)
git diff --stat "$MB" HEAD -- "${FROZEN[@]}"                   # empty = in bounds
git rev-list --count HEAD..origin/zoho-catalyst-app-builder    # >0 = needs rebase
```

Merge-base shows only what **your branch** touched. The count reports "behind" separately.
Verified against both branches: both in bounds, Catalyst one commit behind.

## 2. xcheck against the SHARED branch — adopted, it is better than mine

Firebase deviated deliberately and was right. Its first reason stands alone: the shared branch
is the normative source for root `package.json` and `tsconfig.json`, both builds are frozen to
it, so matching it proves the two builds match **each other transitively**. It also sidesteps
the question of whether one build may touch the other's branch at all.

`territory.md` now specifies the shared branch, with `XCHECK_REF` to override.

Also adopted: **an absent or unparseable count must FAIL, not pass.** That is the "missing is
drift" rule turned on the guard itself.

## 3. Measurement discipline — now in the checklist G section

Firebase measured `10 ABORTED: Transaction lock timeout` on its single counter document at
32-way concurrency. **Intermittently** — the next run landed all 32 clean.

Three rules from it:

**Never report a single-run figure as a threshold.** "The ceiling is 32" is one run. The honest
form is "refusal becomes probable above roughly a dozen concurrent appends, and the documented
retry clears it", plus the distribution across N runs. Anyone quoting a hard number has
measured once.

**An intermittent test is worse than a failing one.** A failing test is information. Red under
load and green otherwise converts an open question into noise, and it will be re-run until it
passes and then trusted. Same defect as asserting count instead of correlation: it cannot
reliably distinguish the bug from the fix.

**Assert the contract, not your expectation of it.** Firebase's own diagnosis, and the sharpest
point in the report: `ABORTED` maps to `StoreBusyError`, which the interface defines as a normal
retryable outcome. Asserting "all 32 resolve" was asserting that the contract is not the
contract. The adapter was right; the test was wrong.

## 4. G9 entry 1 upgraded from theoretical to measured

The register said Firebase's counter doc was "first-class" with no cost. Measured, it is
first-class **and** has a real contention ceiling. The entry now reads: Catalyst pays with an
explicit CAS retry loop it had to design; Firebase pays with an implicit one it gets from the
SDK. **Both need a retry; only one had to think about it.**

That is a smaller asymmetry than the register first claimed, and correcting it downward matters
as much as finding the big ones. A register that only ever grows in Catalyst's disfavour is not
measuring, it is arguing.

## Do

Not blocking. Rerun the corrected territory check at your next rebase.
**Catalyst:** you are one commit behind; rebase for 0011 and 0012.
