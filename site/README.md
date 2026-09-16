# `site/` — the Flotilla web pages

Two static pages, no build step, no dependencies. Open either file directly or serve the
directory.

| File | Audience | Indexed |
|---|---|---|
| `index.html` | **Public.** Clients and prospective users. What Flotilla is, the board, roles, cost, how to start. | yes |
| `how-it-works.html` | **Internal reference.** Mechanism end to end, including what does not work and the measured numbers. | no — carries `noindex,nofollow` |

`site.css` is shared by both, so the reference page is visually the same product as the public
page. It is the only stylesheet.

## Design language

Tokens are copied verbatim from `client/src/tokens.css`, whose source of truth is
`docs/designs/dashboard.md`. Fraunces for headings, Inter for body, JetBrains Mono for
identifiers and code. Single teal accent, warm paper background, hairline borders, light mode
only. **Do not introduce a colour that is not in the token block at the top of `site.css`** —
divergence from the board is treated as a bug, the same rule the dashboard follows.

The miniature board in `index.html#board` reuses the dashboard's own card, tag, avatar and
empty-state idioms rather than illustrating them, so it cannot drift from the real thing
stylistically.

## Brand assets

`site/brand/` holds **copies** of the few SVGs these pages use. Canonical masters and the
usage rules live in `client/public/brand/` — see `client/public/brand/README.md`. If a master
changes, re-copy:

```bash
cp client/public/brand/{flotilla-lockup,flotilla-lockup-white,flotilla-mark,flotilla-mark-white,favicon}.svg site/brand/
cp client/public/brand/exports/social/flotilla-og.png site/brand/exports/social/
cp client/public/{favicon.svg,favicon-32x32.png,favicon-16x16.png,apple-touch-icon.png} site/
```

Brand rules that apply here: use the white lockup on the dark band, never recolour or rotate
the mark, keep it at 24 px tall or larger, and leave 20% of its height clear on every side.

## Serving it

```bash
python3 -m http.server 8080 --directory site
# http://localhost:8080/               public page
# http://localhost:8080/how-it-works.html   reference
```

The public page does not link to the reference page — it is reachable by URL only, and the
reference page links back. Keep it that way, or move the reference page behind auth before
linking it.

## Accuracy

Both pages assert things about the product. The normative sources are the files under `docs/`;
the reference page ends with a source map naming each one. When mechanism changes, these pages
are a user-facing surface and count as part of the change — the project has lost this bet three
times already (a webhook named on screen for weeks after it became a poll, and two renames that
missed a surface the product prints).
