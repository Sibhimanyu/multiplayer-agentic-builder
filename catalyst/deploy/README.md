# Deploy tree

`catalyst/tools/build-functions.ts` compiles the TypeScript sources into a Catalyst-shaped
function directory here. Everything in this directory except this README is **generated** —
gitignored, never edited, always overwritten.

## One function, six routes — and why

The build order lists six Advanced I/O functions. They are deployed here as **one** function
hosting six routes.

An Advanced I/O function is a raw `(req, res)` Node handler, so routing inside it is the normal
shape rather than a workaround, and the six logical endpoints are preserved exactly as routes.
What changes is deployment granularity, and the reason is measurement honesty rather than
convenience: each function directory carries its own `node_modules` and its own compiled copy
of the shared code, so six directories means six npm installs and six upload payloads for a
latency figure that is identical either way. The platform's per-invocation overhead does not
depend on how many sibling functions exist.

The one thing this does change is the concurrency ceiling. Catalyst allows 10 concurrent
executions **per function per environment**, so six functions would have had 60 slots and this
has 10. That makes the G2 concurrency numbers pessimistic rather than flattering, which is the
right direction for a bake-off, and it is recorded with the numbers.
