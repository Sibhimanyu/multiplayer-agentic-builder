---
order:    0058
to:       firebase
issued:   2026-09-16
blocking: yes
---

# The installer served a build without `whoami`. And the rename missed the env vars.

The user ran `flotilla whoami` and got `unknown command` — on a machine that had installed from the
curl one-liner. The command exists; **the hosted tarball was built before it did.**

## Defect 1 — nothing re-deploys the tarball

`client/dist/flotilla-cli-0.1.0.tgz` is what `install.sh` downloads. It is updated **by hand, by me,
when I remember.** Every CLI change since the last upload was invisible to anyone installing.

**This is the third artifact in this project that only exists in git.** The rules were three weeks
stale while hosting deployed repeatedly (order 0053). The compiled `lib/` was stale while source was
edited (entry 76). Now the tarball.

**Make the tarball part of the build.** A hosting deploy that ships a client bundle and a CLI tarball
built from different commits is the bug, and it cannot be fixed by remembering.

**And assert it**: the served tarball's version and a marker from the current source must match. A
check that compares the file to itself proves nothing — compare the **downloaded** artifact against
the **repo**, the way the project-id grep compares the built bundle rather than the source.

## Defect 2 — `--help` still prints `BUILDER_*`

```
FLOTILLA_UID         your member id
BUILDER_API_URL      coordination API base url
BUILDER_REPO         owner/repo for the git blackboard
BUILDER_GIT_TOKEN    token for reading contracts from a private repo
```

One renamed, three not. **Third time a rename has covered the binary and missed something it
prints** — after `builder claim` in generated role packs (entry 78) and the webhook copy in the empty
state (entry 70).

Rename them to `FLOTILLA_*`. **Accept the old names for one release** with a deprecation line on
stderr — someone may have them exported — then assert **zero** `BUILDER_` in the built bundle, not
the source.

## The pattern worth naming

Three renames, three misses, each in a different surface: generated files, UI copy, env vars. The
fix is not more care. **Assert the absence of the retired name in every artifact the user can
see** — bundle, generated output, `--help`, and the served tarball. One assertion, run everywhere,
instead of a checklist someone works through.

## Verify

`curl` the **hosted** installer, install it in a clean directory with a scrubbed environment, and
assert `flotilla whoami` answers and `--help` contains no `BUILDER_`. That is the artifact rule
applied to the thing a stranger actually receives.
