# Order 0074 — nobody could install Flotilla

`/plan-devex-review`, Pass 1. The first command in the README, the one every new developer runs:

```
$ curl -fsSL https://multiplayer-agents-eec02.web.app/install.sh | sh
sh: line 1: syntax error near unexpected token `newline'
sh: line 1: `<!DOCTYPE html>'
```

**Time to hello world: infinite.** Not poor onboarding — no onboarding. Score 0/10.

## Why it was invisible

`firebase.json` had one rewrite: `{"source":"**","destination":"/index.html"}`. Every missing path
answers **HTTP 200 with `text/html`**. So `install.sh` passed every status-code check ever run
against it. Twenty minutes before finding this I measured `200, 1829 bytes` myself and moved on:
the same true-signal-about-the-wrong-subject failure this project keeps recording.

The tarball was gone too. `/flotilla.tar.gz`, `/cli.tar.gz`, `/flotilla-cli-0.1.0.tgz` — all 200,
all HTML.

## Why it happened, including my part

Both artifacts existed **only** in `client/dist/`. That directory is gitignored (`.gitignore:12`)
and `vite build` empties it. `git log -S "install.sh"` finds no commit that ever added one, and
the `flotilla-cli` manifest referenced a `build.mjs` that is nowhere in the repo. The whole
packaging recipe lived in a build-output directory.

I ran `npm run build` about eight times on 2026-09-17. That deleted them permanently.

**Order 0058 called this on 2026-09-16**, `blocking: yes`: *"nothing re-deploys the tarball… it is
updated by hand, by me, when I remember. Make the tarball part of the build."* It named itself the
**third** artifact to rot this way, after the security rules (3 weeks stale, order 0053) and the
compiled `lib/` (entry 76). Nothing was built. A day later the pattern finished: the artifact did
not go stale, it ceased to exist.

## What now exists, all tracked

- `packaging/package.json` — the `flotilla-cli` manifest, recovered from the installed copy on
  this machine, now source.
- `packaging/install.sh` — the installer. It checks gzip magic on what it downloads, because a
  successful `curl` against this host proves nothing about *what* arrived.
- `scripts/build-cli.mjs` — esbuild bundles `firebase/flotilla-main.ts` with the shebang, `npm
  pack`s it, copies the tarball and installer into `client/dist`. Refuses to finish if
  `install.sh`'s hardcoded version disagrees with the manifest.
- `scripts/build-all.sh` (`npm run build:all`) — web then CLI. **Order is load-bearing:** `vite
  build` empties `client/dist`, so reversing the two lines silently unpublishes the installer.
- `scripts/predeploy.sh` — the gate, wired to `hosting.predeploy`. A deploy missing `index.html`,
  `install.sh` or the tarball fails with the reason and the fix.
- `scripts/verify-published.mjs` (`npm run verify:published`) — fetches both and checks **bytes,
  not status**: `content-type` must not be `text/html`, the installer must start with a shebang,
  the tarball must start with `1f 8b`.

## The guard builds, then it doesn't

Building inside `predeploy` was tried first and abandoned with evidence. Firebase spawns predeploy
in its own environment: `npm run` dies there with `Cannot read properties of undefined (reading
'stdin')`, and calling `./node_modules/.bin/vite` directly picks up a different node and dies with
`ERR_REQUIRE_ESM`. Both surface only as `predeploy error: exit code 1`.

So the build is explicit and the gate is pure `sh` with no node, no npm and no PATH assumptions.
The guarantee order 0058 asked for is intact — a deploy that would unpublish the installer fails
instead — it just does not depend on Firebase's environment.

## Verified, not assumed

Every guard was proven to fire before being trusted:

```
verify-published, against the broken site:
  FAIL  /install.sh — content-type is text/html; charset=utf-8 — the SPA rewrite served index.html
  FAIL  /flotilla-cli-0.1.0.tgz — content-type is text/html; charset=utf-8
  exit=1

predeploy, with install.sh removed:
  predeploy: FAIL -- client/dist is missing: install.sh
  exit=1

after the fix:
  PASS  /install.sh — 2066 bytes, application/x-sh
  PASS  /flotilla-cli-0.1.0.tgz — 34680 bytes, application/x-gtar-compressed
```

Then the README one-liner, run verbatim into a throwaway `npm` prefix so it could not touch the
real install:

```
Downloading flotilla-cli 0.1.0…
Installing…

flotilla 0.1.0 is installed.
```

## Caught by running it

`flotilla --version` fell through to `default` and printed `unknown command: --version` followed by
the entire help screen — and the installer's own success line calls it, so the last thing a fresh
install said was the help text with the word `flotilla` in front of it. `-v` / `--version` now
print the version, injected at build time from `packaging/package.json` so a published binary
cannot disagree with the tarball it shipped in. From source it reports `0.1.0-dev` rather than
claiming a release number.

## Closes

Order 0058. Shared tests pass, edge harness 183/183.
