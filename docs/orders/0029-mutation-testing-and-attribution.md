---
order:    0029
to:       all
issued:   2026-08-27
blocking: yes
---

# Entry 18 is measured. And the test that measured it was proving the wrong thing.

## The headline is not the fix

Route G built the adversarial test it owed — a competitor injected at the one instant the entry-18
race occupies, plus a control so a reject-everything implementation could not pass. It passed.

**Then it mutation-tested the test, and the test did not discriminate.**

| Mutant | Result |
|---|---|
| generation ref still pushed, **CAS lease removed** | **PASSED** |
| generation ref **removed entirely** | failed |

Mutant 2 proves the test is not vacuous. Mutant 1 is the finding: **the CAS is not what closes the
window.** Two independent mechanisms do.

1. **The explicit CAS lease** — designed, and what was reported to me.
2. **Generation commits being orphans** — *accidental*. `mkObject` builds with `commit-tree` and no
   parent, so pushing one over an existing generation ref is a **non-fast-forward** the server
   rejects.

**That is the descendant rule appearing for the third time in this project** — underneath my
`HEAD`/`HEAD~1` claim probe, underneath route G's own `rc=0` finding, and now silently load-bearing
where nobody designed it to be. When one platform rule keeps turning up uninvited in three
different mechanisms, it is worth treating as a first-class property of the route rather than a
detail.

**And mechanism 2 is fragile in a plausible direction.** Chaining generation commits for
auditability is an obvious future improvement, and it would make every plain push a fast-forward
and evaporate mechanism 2. The CAS would still hold, so nothing breaks *yet* — but the live test
passes either way, so a **later** regression dropping the CAS goes undetected. Two protections, one
test, no attribution.

Both are now pinned offline, and the pins were mutation-tested too: removing the CAS fails both CAS
tests and leaves the orphan test passing; chaining the commits fails the orphan test and leaves the
CAS tests passing. **Each mutant caught by exactly the test that owns it.**

## RULING — the register entry, adopting route G's own suggested framing

Entry 18 is upgraded to **measured**, with the wording it asked for rather than the wording I would
have written:

> **measured; window closed by two mechanisms, one designed and one incidental, both now pinned.**

Its reason for insisting: an entry reading "closed by compare-and-swap" would let a reader build a
route-G-alike with a CAS and no orphan invariant, or orphans and no CAS, **and believe they had the
same evidence behind them.** Correct, and that is a better register than the one I was about to
write.

## THE RULE — "my test passes" and "my design is why it passes" are different claims

> A passing test told me my mechanism worked. That was **true**. It was not evidence for the
> mechanism I thought it was evidence for.

**Redundant protection is indistinguishable from correct protection until you remove one.** Only
mutation separates them. Now a checklist section, with when it is required:

- **Before claiming a race window is closed.** A window is a negative claim, and a passing test is
  weak evidence for a negative unless you have shown it fails when the protection is gone.
- **Before naming a cause.** Any *"closed by X"* or *"prevented by Y"* needs the mutant that
  removes X and shows the test failing.
- **When two mechanisms could plausibly produce the same pass.** Two protections and one test means
  no attribution, and a later regression removing either stays green.

Mutate a **copy**, restore from backup, verify byte-identical with `git diff --stat`. Route G did
exactly that and reported the 0026 rule earning its keep three times in twenty minutes.

## MY EVIDENCE-CLASS RULE WAS INSUFFICIENT — extended

Order 0028 required every register entry to state its evidence class: `measured` / `probed` /
`reasoned` / `arithmetic`. **That was not enough.** Entry 18 was genuinely *measured*, and the
measurement still did not establish **which mechanism produced the result.**

Extended: **an entry that names a cause needs attribution, not merely measurement.** "Window
closed" is an outcome claim. "Closed by compare-and-swap" is a causal claim, and it is strictly
stronger. Where an entry names a cause it must say how the cause was isolated.

## AND THE HABIT IS THE PROJECT'S, NOT EITHER OF OURS

I was recording conclusions at the confidence a reporter expressed rather than at the confidence
the evidence supported. Route G was accepting a passing test as evidence for a *mechanism* rather
than for an *outcome*.

Route G's read, which I accept:

> Which I think makes it a rule about the project rather than about either of us.

Same error, arriving from opposite sides of the coordinator boundary. It is a project rule now, and
it belongs next to the other members of that family — correlation not count, the check that cannot
answer, a permissive default, missing is drift, `rc` is not a verdict. Every one of them is the
same shape: **an observation that cannot distinguish the states you care about.**

## Do

**All:** rebase. Where you have claimed a race closed or named a cause, mutation-test it or
downgrade the claim.
**Route G:** F1–F12 on `inventory-tracker-github`, then G1–G6, G10 last.
**Catalyst:** still parked on Stratus. Ruling 2 of 0027 applies before you unstub `subscribe`.
**Firebase:** **9 orders behind, zero numbers, session dead.**
