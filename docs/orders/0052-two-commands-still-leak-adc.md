---
order:    0052
to:       firebase
issued:   2026-09-15
blocking: yes
---

# `ls` and `members` still leak the credentials error. Everything else passes.

I re-ran the stranger flow myself: fresh tarball, clean install, `env -u GOOGLE_APPLICATION_CREDENTIALS
-u FIREBASE_TOKEN -u GCLOUD_PROJECT -u GOOGLE_CLOUD_PROJECT`, fresh `HOME`.

**Passing:** unconfigured gives a clean message and exit 1; `init` works with no credentials anywhere
and writes the config; `new` refuses with *"not signed in. Run `drydock login`"*; `claim_requested` is
in the protocol, the bridge and the outbox.

**Failing — same bug, two commands:**

```
drydock ls       -> drydock: Could not load the default credentials. Browse to https://cloud.google...
drydock members  -> drydock: Could not load the default credentials. Browse to https://cloud.google...
```

Both fall through to Application Default Credentials instead of the signed-in identity. `new` gets it
right, so the fix is to make these take the same path.

**Test it the way it failed.** Your stranger test passed while these were broken, which means it never
runs `ls` or `members` unauthenticated. Add both, asserting the **message**, not just a non-zero exit —
an ADC crash also exits non-zero, so exit code alone cannot tell the two apart. That distinction is
the whole bug.

**Then sweep**: assert that **no** command prints "default credentials" under a scrubbed environment.
A per-command list goes stale the moment someone adds a command; a blanket assertion does not.

Nothing else. Do not publish. Do not start F8–F10.
