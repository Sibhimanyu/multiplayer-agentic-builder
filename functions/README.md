# Advanced I/O functions

Six functions, one directory each, per build order step 4.

**Status: skeletons.** The request contract, authorisation, validation and error mapping are
written and tested. The Data Store calls are stubbed behind ports and marked `NOT WIRED`,
because none of it can be deployed or verified without a Catalyst project ID — see the
blocked list in `docs/handoff/impl-catalyst-notes.md`. Nothing here claims to work.

| Function | Route | Why Advanced I/O |
|---|---|---|
| `append` | `POST /append` | 30 s cap is ample; writes go through the seq allocator |
| `claim` | `POST /claim` | atomic INSERT against `task_claims.claim_key` |
| `events` | `GET /events` | ZCQL read, capped at 300 |
| `connect` | `POST /connect` | invite code -> agent token, once |
| `role-pack` | `GET /role-pack` | returns pointers, never prompt bodies |
| `github-webhook` | `POST /github/webhook` | **needs the raw body for HMAC** |

The webhook is the reason the whole stack uses Advanced I/O rather than Basic I/O: it is the
only Catalyst function type that can hand a handler the raw request bytes. Any JSON
middleware that parses the body before the signature check breaks D1 permanently, so the
route registers a raw body parser and the JSON parse happens *after* verification.

## Shared code

`functions/_lib/` holds `http.ts` (CORS without duplication, error -> status mapping, body
validation, server-owned-field rejection) and `auth.ts` (token -> agent -> project -> role,
resolved on every request).

Catalyst deploys each function directory independently, so shared code is either copied in at
package time or published. That is a deploy concern, unresolved until there is a project to
deploy to, and it is on the blocked list rather than silently assumed.
