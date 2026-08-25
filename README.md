# Catalyst Builder

Catalyst Builder is a planned open-source, lightweight multiplayer agentic app builder for Zoho Catalyst apps.

The product is deliberately not a hosted agent sandbox platform. Catalyst hosts the coordination dashboard and API. GitHub stores code, branches, pull requests, and review history. Each builder runs their own local agent harness, such as Claude Code or Codex, through a small `catalyst-builder` CLI bridge.

## Core Idea

```text
Catalyst Builder Dashboard
        |
Catalyst Functions + API Gateway
        |
Catalyst Data Store
        |
GitHub repo, branches, PRs, CI
        |
Local catalyst-builder CLI
        |
Claude Code / Codex / other local agent harness
```

The important rule is that agents do not directly talk to each other. They coordinate through Catalyst by writing structured events, messages, task state, and heartbeats. GitHub remains the code source of truth.

## Documentation

**Start here**

- [Store interface](docs/reference/store-interface.md) - the contract both implementations satisfy
- [Agent coordination protocol v0.2](docs/protocol/agent-coordination.md)
- [The `.agentic/` file contract](docs/reference/agentic-file-contract.md) - CLI to agent interface
- [The git blackboard](docs/reference/blackboard.md) - where durable facts live
- [Dashboard design](docs/designs/dashboard.md) - approved tokens and patterns
- [Acceptance checklist](docs/how-to/acceptance-checklist.md) - identical bar for both builds
- [Next-agent handoff](docs/handoff/next-agent.md)

**Implementation briefs**

- [Workspace 1: Catalyst](docs/handoff/impl-catalyst.md)
- [Workspace 2: Firebase](docs/handoff/impl-firebase.md)

**Background**

- [Product design](docs/designs/catalyst-builder.md) - product framing; architecture superseded
- [Original API sketch](docs/reference/coordination-api.md) - superseded, kept for the table shapes
- [First vertical slice](docs/how-to/build-first-vertical-slice.md) - superseded by the briefs above

## Current Status

**Phase 0 complete.** The spec is written and the shared dashboard is built, typechecked and
rendering. No backend exists yet.

**Phase 1** builds two implementations in parallel from this one spec:

| Route | Stack | Fresh | Cost | Est. |
|---|---|---|---|---|
| Catalyst C1 | Slate + Advanced I/O + Data Store + Stratus + Cache | ~5 s | ~$5/mo | ~1 day |
| Firebase F | Hosting + Firestore + one Cloud Function | <1 s | $0 | ~4 hrs |

Both satisfy the same interface and are measured against the same checklist. The point is to
replace estimates with real latency and cost numbers, then choose.

The dashboard, the protocol, the `.agentic/` contract and the git blackboard are shared and
written once. Only the store adapter differs.

## External References

- Zoho Catalyst Web Client Hosting: https://docs.catalyst.zoho.com/en/cloud-scale/help/web-client-hosting/introduction/
- Zoho Catalyst Advanced I/O Functions: https://docs.catalyst.zoho.com/en/serverless/help/functions/advanced-io/
- Zoho Catalyst API Gateway: https://docs.catalyst.zoho.com/en/cloud-scale/help/api-gateway/introduction/
- Zoho Catalyst Data Store: https://docs.catalyst.zoho.com/en/cloud-scale/help/data-store/introduction/
- Zoho Catalyst Authentication: https://docs.catalyst.zoho.com/en/cloud-scale/help/authentication/introduction/
- Zoho Catalyst Signals: https://docs.catalyst.zoho.com/en/signals/getting-started/introduction/
- QM reference project: https://github.com/yc-software/qm
