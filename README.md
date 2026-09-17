# flotilla.site

The Flotilla website. Two static pages, no build step, no dependencies.

| File | Audience |
|---|---|
| `index.html` | **Public.** What Flotilla is, the board, roles, cost, how to start. |
| `how-it-works.html` | **Internal reference.** Mechanism end to end, including what does not work. `noindex`. |
| `site.css` | Shared by both, so the reference page is visibly the same product. |

Published by GitHub Pages from `main` at **https://sibhimanyu.github.io/flotilla/**

## This repo is the site only

The product, the CLI and the engineering record live in
[Sibhimanyu/multiplayer-agentic-builder](https://github.com/Sibhimanyu/multiplayer-agentic-builder).
That repo keeps its name deliberately: decision 0004 lists it as live
infrastructure and rules out renaming it, so the site got its own home rather
than the product repo getting a new name.

## Design language

Tokens are copied verbatim from the dashboard's `client/src/tokens.css`, whose
source of truth is `docs/designs/dashboard.md` in the product repo. Fraunces for
headings, Inter for body, JetBrains Mono for identifiers. Single teal accent,
warm paper ground, light mode only.

**Do not introduce a colour that is not in the token block at the top of
`site.css`** — divergence from the board is treated as a bug.

Illustrations share one vocabulary (`il-rail`, `il-live`, `il-card`, `il-lbl`,
`il-warn`), declared once. A diagram that needs a new weight or colour means the
vocabulary is wrong, not that it needs an exception.

## Serving it locally

```bash
python3 -m http.server 8080
```

## Brand assets

`brand/` holds copies of the SVGs these pages use. The canonical masters and the
usage rules live in `client/public/brand/` in the product repo.
