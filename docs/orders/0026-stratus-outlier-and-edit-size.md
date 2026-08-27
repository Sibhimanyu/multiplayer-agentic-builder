---
order:    0026
to:       all
issued:   2026-08-27
blocking: no
---

# Stratus is an outlier, not a misconfiguration. Two new rules.

## Probe result, timestamped

```
2026-08-27T07:32:42Z
Create_Bucket -> OPERATION_NOT_ALLOWED
"User needs to be in session when accessing Stratus for the first time"
```

Byte-identical to both earlier attempts. One call, no loop, no workaround, parked.

**Recording the instant is now a rule.** "Still shut" is ambiguous about *when* — a probe at 07:32
says nothing about a console visit that lands at 07:40, and whoever compares them later cannot
tell. Timestamp every gate re-probe alongside the verbatim error.

## THE NARROWING — accepted, with one piece of evidence removed

**Four services accepted their first API call on this identity with no console visit at all:**
Data Store, Functions, Cache and Job Scheduling. Nine tables, 63 columns, two functions, a job
pool and a cron, all provisioned through the API.

**So Stratus is an outlier, and an outlier is a platform finding rather than a configuration
mistake.** The project is demonstrably set up correctly — this rules out "we did the setup wrong",
which was the other live explanation. Register entry 21.

**Correction, and it is the same rule turned on the report itself:** the claim included Slate among
the silently-activated services. It cannot count. Slate was verified open **after** the human's
console visit, so that observation cannot distinguish *"Slate activated silently via API"* from
*"Slate activated because it was clicked"*. It is exactly the read-is-not-a-probe shape: the
observation is compatible with both states.

Four data points still make Stratus an outlier. The conclusion holds; one of its five supports does
not, and the register records four rather than five.

## Register entry 22 — you cannot tell which identity you are acting as

`catalyst whoami` reports a display name only — *"Sibhimanyu G undefined"* — no email, and no CLI
config exposes one. I hit this independently and got the same nothing.

So when an error says a **session** is required, **nobody involved can verify which identity needs
it.** The human is being asked to open the console as a specific account while having no way to
confirm from the tooling which account the API acts as. That is part of why this gate has taken
three attempts, and it is a diagnosability finding in its own right, separate from the gate.

By contrast: `firebase login:list` prints the account, and a service-account key names its own
`client_email`.

## RULE — check the SIZE of a mechanical edit, not just its result

Reported against itself, caught before committing. An unquoted heredoc command-substituted
backticks inside markdown; the fix used a DOTALL regex that matched too greedily and **deleted 999
lines** of notes. `git diff --stat` caught it.

> I checked the *result* of the mechanical edit and it looked right, when what I needed to check
> was its *size*.

Same family as the retry loop hiding a cost and a successful read not being a probe: the
observation could not distinguish *"fixed one line"* from *"fixed one line and deleted a
thousand"*.

**`git diff --stat` is the correlation check for edits.** Run it before every commit a script or
regex produced, and read the line counts rather than glancing at the file.

Coordinator note: I have been making scripted edits to shared docs all project and had **not**
been doing this. Adopted immediately — the commit carrying this order was verified at 25
insertions, 0 deletions before it landed. Also: use a **quoted** heredoc (`<<'EOF'`) for anything
containing backticks.

## Two hypotheses for the human, cheapest first

The identity hypothesis is no longer the only candidate, and the other is cheaper to test.

**1. The activation may need an explicit click, not just a page load.** Slate's documented
activation is *"click **Start Exploring**"* — a button, not a visit. Signals and SmartBrowz are
documented the same way. If Stratus carries the same control, opening the page is not enough and
the button was never pressed. **Test first: it costs one click and no account switching.**

**2. Identity mismatch.** The API acts as an account that may differ from the browser session, and
entry 22 means nobody can confirm which. Test second.

## Do

**Catalyst:** parked correctly. Timestamp the next re-probe.
**Firebase and route G:** unaffected. Adopt the edit-size rule.
