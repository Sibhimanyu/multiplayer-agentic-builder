# Coordination API Reference

## Overview

> **SUPERSEDED 2026-08-25 by [store-interface.md](store-interface.md).**
> Do not implement from this file. It predates the platform audit and contains three
> designs that cannot be built as written:
> 1. `seq` monotonic per project - Catalyst has no sequence primitive. Use `ROWID`.
> 2. Compare-and-set task claim - Data Store has no transactions. Use an `is_unique` insert.
> 3. `*_json` columns - there is no JSON type; `text` caps at 10,000 chars and silently
>    mangles emoji. Contracts belong in git, with a pointer in the event.
> The table shapes below are still broadly useful as a starting point.

This document describes the originally planned public surface. It is a design reference, not implemented code.

Catalyst should expose these APIs through API Gateway and Advanced I/O Functions. Data should persist in Catalyst Data Store.

## Data Store Tables

### `projects`

| Field | Type | Notes |
| --- | --- | --- |
| `project_id` | string | Primary id |
| `name` | string | Display name |
| `description` | string | App brief |
| `owner_user_id` | string | Creator |
| `github_repo_url` | string | Connected repository |
| `status` | string | `draft`, `active`, `archived` |
| `created_at` | datetime | Server timestamp |
| `updated_at` | datetime | Server timestamp |

### `members`

| Field | Type | Notes |
| --- | --- | --- |
| `member_id` | string | Primary id |
| `project_id` | string | Project |
| `user_id` | string | Catalyst auth user |
| `role_id` | string | Assigned role |
| `status` | string | `invited`, `active`, `revoked` |
| `created_at` | datetime | Server timestamp |

### `roles`

| Field | Type | Notes |
| --- | --- | --- |
| `role_id` | string | Primary id |
| `project_id` | string | Project |
| `name` | string | Example: `Backend Builder` |
| `slug` | string | Example: `backend-builder` |
| `skills_json` | json | List of skills assigned |
| `permissions_json` | json | Claim and Git permissions |
| `prompt_markdown` | text | Role-specific agent prompt |
| `branch_prefix` | string | Example: `agent/backend` |

### `agents`

| Field | Type | Notes |
| --- | --- | --- |
| `agent_id` | string | Primary id |
| `project_id` | string | Project |
| `member_id` | string | Owning member |
| `role_id` | string | Role pack |
| `harness` | string | `claude-code`, `codex`, `manual`, etc. |
| `status` | string | `connected`, `idle`, `working`, `blocked`, `offline`, `revoked` |
| `last_heartbeat_at` | datetime | Staleness check |
| `current_task_id` | string | Nullable |

### `tasks`

| Field | Type | Notes |
| --- | --- | --- |
| `task_id` | string | Primary id |
| `project_id` | string | Project |
| `title` | string | Short task label |
| `description` | text | Task instructions |
| `kind` | string | `frontend`, `backend`, `qa`, `docs`, `devops` |
| `status` | string | See protocol state machine |
| `claimed_by_agent_id` | string | Nullable |
| `branch` | string | Git branch |
| `pr_url` | string | GitHub PR |
| `depends_on_json` | json | Task ids |
| `file_scope_json` | json | Expected file ownership |
| `created_at` | datetime | Server timestamp |
| `updated_at` | datetime | Server timestamp |

### `events`

Append-only coordination log.

| Field | Type | Notes |
| --- | --- | --- |
| `event_id` | string | Primary id |
| `project_id` | string | Project |
| `seq` | number | Monotonic per project |
| `actor_type` | string | `owner`, `member`, `agent`, `github`, `system` |
| `actor_id` | string | Actor id |
| `type` | string | Event type |
| `payload_json` | json | Event payload |
| `created_at` | datetime | Server timestamp |

### `messages`

Per-agent inbox.

| Field | Type | Notes |
| --- | --- | --- |
| `message_id` | string | Primary id |
| `project_id` | string | Project |
| `agent_id` | string | Recipient |
| `seq` | number | Monotonic per agent |
| `type` | string | Message type |
| `task_id` | string | Nullable |
| `body` | text | Message body |
| `payload_json` | json | Structured body |
| `read_at` | datetime | Nullable |
| `created_at` | datetime | Server timestamp |

### `github_links`

| Field | Type | Notes |
| --- | --- | --- |
| `github_link_id` | string | Primary id |
| `project_id` | string | Project |
| `repo_url` | string | Repository URL |
| `installation_id` | string | Future GitHub App support |
| `webhook_secret_ref` | string | Secret reference, not raw value |
| `status` | string | `pending`, `active`, `disabled` |

## API Endpoints

### Create Project

```http
POST /api/projects
```

Request:

```json
{
  "name": "Inventory Tracker",
  "description": "A Catalyst app for managing inventory items.",
  "github_repo_url": "https://github.com/org/inventory-tracker"
}
```

Response:

```json
{
  "project_id": "proj_01",
  "status": "draft"
}
```

### Invite Member

```http
POST /api/projects/{project_id}/invites
```

Request:

```json
{
  "email": "teammate@example.com",
  "role_id": "role_backend"
}
```

Response:

```json
{
  "invite_code": "inv_abc",
  "expires_at": "2026-08-31T00:00:00Z"
}
```

### Connect CLI

```http
POST /api/connect
```

Request:

```json
{
  "invite_code": "inv_abc",
  "harness": "claude-code",
  "machine_label": "sibhi-macbook"
}
```

Response:

```json
{
  "project_id": "proj_01",
  "member_id": "mem_01",
  "agent_id": "agent_01",
  "agent_token": "opaque-project-scoped-token"
}
```

### Fetch Role Pack

```http
GET /api/projects/{project_id}/agents/{agent_id}/role-pack
```

Response:

```json
{
  "role_id": "role_backend",
  "role_slug": "backend-builder",
  "skills": ["catalyst-functions", "catalyst-datastore", "api-contracts"],
  "permissions": {
    "can_push_branches": true,
    "can_open_prs": true,
    "can_merge": false
  },
  "branch_prefix": "agent/backend",
  "agents_md": "# Backend Builder\n\nYou are responsible for Catalyst Functions..."
}
```

### Create Task

The `create_task` op on the write function. Requires the **`triage`** capability — creating work
is a triage act, so owner and architect may do it and the client seat may not. See
`docs/decisions/0005-work-appears-by-triage.md`.

```http
POST <write function>
{ "project_id": "...", "op": "create_task",
  "body": { "title": "Items list page", "kind": "frontend",
            "task_id": "task_items_list_page",   // optional; derived from the title when absent
            "description": "...", "depends_on": [], "file_scope": [] } }
```

Rules:

- `title` is required; `kind` must be one of `frontend|backend|qa|docs|devops` and is **refused**
  rather than defaulted — a task quietly filed under the wrong kind is a card in the wrong
  swimlane that nobody can explain a week later.
- The creator is the **verified uid** from the token. A body-supplied actor is ignored.
- Idempotent on the task id. Creating a task that already exists is `200` with `ok:false` and the
  existing task attached — **not** a `409`. It is the normal outcome of a retry, the same
  reasoning that makes a lost claim a 200.
- Appends exactly one `task_created` event on the coordination layer and moves the project
  rollup by delta.

```json
{ "ok": true, "task_id": "task_items_list_page", "seq": 41 }
```

CLI: `flotilla task "<title>" --kind <kind> [--id <task_id>]`.

### Claim Task

```http
POST /api/projects/{project_id}/tasks/{task_id}/claim
```

Rules:

- Authenticated agent must belong to the project.
- Task kind must match role permissions.
- Task status must be `open`.

Response:

```json
{
  "task_id": "task_backend_crud",
  "status": "claimed",
  "claimed_by_agent_id": "agent_01"
}
```

### Append Event

```http
POST /api/projects/{project_id}/events
```

Request:

```json
{
  "type": "task_progress",
  "payload": {
    "task_id": "task_backend_crud",
    "status": "in_progress",
    "summary": "Created the Catalyst function skeleton."
  }
}
```

Response:

```json
{
  "event_id": "evt_42",
  "seq": 42
}
```

### Poll Events

```http
GET /api/projects/{project_id}/events?since=42
```

Response:

```json
{
  "events": [],
  "next_cursor": 42
}
```

### Poll Agent Inbox

```http
GET /api/projects/{project_id}/agents/{agent_id}/inbox?cursor=10
```

Response:

```json
{
  "messages": [],
  "next_cursor": 10
}
```

### Heartbeat

```http
POST /api/projects/{project_id}/agents/{agent_id}/heartbeat
```

Request:

```json
{
  "status": "working",
  "task_id": "task_backend_crud",
  "branch": "agent/backend/task-backend-crud",
  "harness": "claude-code"
}
```

### GitHub Webhook Receiver

```http
POST /api/github/webhook
```

The function should verify the GitHub signature, map the repository and branch to a project/task, append an event, and update task snapshots.

## Authentication

V1 should use:

- Catalyst Authentication for dashboard users.
- Short-lived invite codes for setup.
- Project-scoped agent tokens for local CLIs.
- Existing local `gh` auth for GitHub operations.

Future versions can add a GitHub App. Do not require a GitHub App for the first vertical slice.
