# How to Build the First Vertical Slice

This guide describes the first implementation slice another agent should build. It is intentionally narrow: prove coordination before automating every harness.

## Prerequisites

- A Zoho Catalyst project for hosting the dashboard and functions.
- A GitHub repository for the Catalyst app being built.
- Local Git and GitHub CLI authentication on each builder machine.
- One local agent harness, initially Claude Code or Codex.

## Step 1: Build the Skeleton Dashboard

Create a Catalyst-hosted web client with these views:

- Project list
- Project detail
- Members and roles
- Tasks
- Event feed
- Agent status

The first UI can poll every 5 seconds.

## Step 2: Create the Coordination API

Implement Advanced I/O Functions behind API Gateway for:

- create project
- invite member
- connect CLI
- fetch role pack
- claim task
- append event
- poll events
- poll inbox
- heartbeat
- receive GitHub webhook

Start with mock auth if needed, but keep the function signatures close to [the API reference](../reference/coordination-api.md).

## Step 3: Add Data Store Tables

Create the tables from [the data model](../reference/coordination-api.md#data-store-tables):

- `projects`
- `members`
- `roles`
- `agents`
- `tasks`
- `events`
- `messages`
- `github_links`

Keep `events` append-only. Use snapshot columns on `tasks` and `agents` for fast reads.

## Step 4: Build the Local CLI Bridge

Implement the minimum CLI commands:

```bash
catalyst-builder connect <invite-code>
catalyst-builder status
catalyst-builder claim
catalyst-builder report "message"
catalyst-builder start
```

For the first version, `start` can write files and print instructions instead of fully launching Claude Code.

Generated files:

```text
AGENTS.md
.agentic/project.json
.agentic/role.md
.agentic/tasks/current-task.md
.agentic/protocol.md
```

## Step 5: Add GitHub Webhook Handling

Configure GitHub to call the Catalyst webhook function on:

- push
- pull request opened
- pull request synchronized
- check suite or workflow completion
- pull request merged

The webhook receiver should append events such as `branch_pushed`, `pr_opened`, `ci_passed`, and `merged`.

## Step 6: Prove the Demo

Use this demo project:

```text
Inventory Tracker
```

Create these tasks:

1. Backend: create item CRUD functions.
2. Frontend: build item list and item form.
3. QA: verify create/list/update/delete.

Assign two roles:

- `backend-builder`
- `frontend-builder`

Expected demo:

1. Owner creates the project.
2. Owner invites two builders.
3. Each builder runs `catalyst-builder connect`.
4. Each builder claims one task.
5. Each builder reports progress.
6. One branch is pushed.
7. One PR is opened.
8. Dashboard updates from GitHub webhook.

## Verification

The slice is done when:

- Dashboard shows a project and task board.
- A local CLI can connect with an invite code.
- A local CLI can fetch a role pack and write `AGENTS.md`.
- A local CLI can claim a task and send progress.
- Dashboard shows heartbeat and progress without page refresh.
- A GitHub branch push or PR event appears in Catalyst.

## Troubleshooting

### CLI cannot connect

Check that the invite code is active, not expired, and mapped to a project member.

### Agent appears offline

Check heartbeat writes. The dashboard should show stale if no heartbeat arrives within the timeout.

### Two agents claim the same task

The claim endpoint must update only when task status is `open`. If the update race fails, return the current owner.

### GitHub webhook does not update dashboard

Verify the webhook signature, repository mapping, branch prefix, and task id extraction.

### Local harness automation is brittle

Do not block the first slice on perfect harness launch. Write the role files and let the user run Claude Code or Codex manually until the bridge is stable.
