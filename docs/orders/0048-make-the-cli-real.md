---
order:    0048
to:       firebase
issued:   2026-09-14
blocking: yes
---

# The UI advertises a command that does not exist. Make it real.

Roles-as-permissions and the client seat landed, 51/51, edge 69/69. Entries 71–73.

Three things there are worth repeating. **Containment is not intersection** — `**` *intersects*
`functions/**`, so reusing the scope-conflict logic would have let an agent asking for the whole repo
pass a backend check; the two biases are opposite on purpose, and using one for the other is a silent
hole. **The conformance suite corrected the design** rather than being overridden — A7 deliberately
has a backend agent lock a frontend file, which proved file scope is per-project policy rather than a
universal constant. And **the injection control has a control**: each inbox *did* receive other
events, so the filter is selecting rather than merely failing.

Now the gap that makes the product unusable by anyone.

## The problem, stated plainly

The projects index says, on screen, in production:

```
Run  drydock new <name>  in your repo.
```

**Every part of that is false.**

| claim | reality |
|---|---|
| a `drydock` command exists | `package.json` has **no `bin`**, is `private: true`, and is still named `catalyst-builder` |
| `new` is a subcommand | dispatch has `connect · claim · report · start · status`. **There is no `new`.** `newproject.ts` exists but nothing routes to it |
| it is installable | nothing is published, nothing is built to JS, `cli/index.ts` is TypeScript run from inside this repo |
| the CLI is called drydock | `cli/index.ts` calls itself **`builder`** 21 times in its own help text |

So the product currently has **three names** — `catalyst-builder` in the manifest, `builder` in the
CLI's help, `drydock` in the UI — and the one the user is told to type is the only one that has never
existed.

**This is mine.** I wrote that empty-state copy into order 0045 and never checked there was a binary
behind it. It is the same class as entry 70's webhook string: a mechanism named in the product that
the product does not have.

## The work

1. **One name.** Package `drydock-cli` (verified free on npm; `drydock` itself is taken). Binary
   `drydock` — `bin` is independent of package name, so the command is still `drydock`. Replace all 21
   `builder` occurrences in the CLI's help and usage text.
2. **Wire `new`.** Route it to `newproject.ts`, alongside the existing subcommands, and make it appear
   in `--help`.
3. **Make it packageable.** Drop `private: true`, add `bin`, add `files`, and **build the CLI to plain
   JS** — an installed user has no TypeScript loader. Keep `shared/**` imports working in the built
   output; they currently resolve as `.ts` paths.
4. **Prove the package, do not assume it.** `npm pack`, then install the resulting tarball into a
   **clean temp directory** and run the real binary from there: `drydock --help` and `drydock new` on a
   throwaway repo. Packaging that works in the source tree and fails from a tarball is the normal
   failure, and only the tarball test can tell them apart. This is the artifact rule — assert the
   installed thing, not the build step's exit code.

## Do NOT publish

**Publishing is the user's call, not mine and not yours.** It claims a name on a public registry
permanently and cannot be meaningfully undone. Get it publish-*ready* and report the exact command
they would run. Nothing leaves this machine.

## Then fix the copy honestly

Once `drydock new` genuinely exists, the empty state is true and stays. If any step above cannot be
finished, **change the copy to match reality in the same commit** — a UI that names a command it does
not have is worse than a UI that says "no projects yet" and nothing else.

## Standing rules

Assert the artifact, not the return value — here that means the installed binary, not `npm pack`
succeeding. A control that never fires has not been run. `--test-concurrency=1`. Gate suites get a
verified-fresh emulator proven by identity. `attempts` 6, `cap_ms` 2,000.
