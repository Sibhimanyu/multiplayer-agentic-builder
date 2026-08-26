// POST /connect -- redeem an invite code for a project-scoped agent token.
//
// Invite codes are short-lived and single-use. Single-use is enforced by the
// same unique-constraint primitive as everything else: redeeming inserts the
// agent row, and the invite is marked spent by its own unique key. There is no
// transaction, so the insert IS the check.
//
// The token is returned ONCE and only its SHA-256 hash is stored. A database
// dump therefore yields no working credentials.
//
// NOT WIRED: Data Store calls are behind ConnectPort. Needs a project ID.

import { randomBytes } from 'node:crypto';

import type { AgentId, ProjectId } from '../../shared/store/types.ts';
import { StoreAuthError } from '../../shared/store/errors.ts';
import { sanitizeText } from '../../shared/sanitize.ts';
import type { Logger } from '../../shared/log.ts';
import { hashToken } from '../_lib/auth.ts';
import type { HttpResponse } from '../_lib/http.ts';
import { json, rejectServerOwnedFields, requireString } from '../_lib/http.ts';

export interface InviteRow {
  invite_code: string; project_id: ProjectId; member_id: string;
  role_slug: string; member_label: string; expires_at: string;
}

export interface ConnectPort {
  findInvite(invite_code: string): Promise<InviteRow | null>;
  /** INSERT into agents. Throws DuplicateValueError if the id is somehow taken. */
  insertAgent(row: Record<string, unknown>): Promise<void>;
  /** Mark the invite spent. Its unique key makes a second redemption lose. */
  spendInvite(invite_code: string): Promise<void>;
}

export function newAgentId(): AgentId {
  return `agent_${randomBytes(4).toString('hex')}`;
}

export function newAgentToken(): string {
  return `agt_${randomBytes(24).toString('hex')}`;
}

export async function handleConnect(
  port: ConnectPort, body: unknown, now: () => Date, log: Logger,
): Promise<HttpResponse> {
  rejectServerOwnedFields(body);
  const invite_code = requireString(body, 'invite_code');
  const harness = requireString(body, 'harness');

  const invite = await port.findInvite(invite_code);
  // One message for "no such invite" and "expired" alike: distinguishing them
  // tells an attacker which codes exist.
  if (!invite) throw new StoreAuthError('invite code is invalid or expired');
  if (new Date(invite.expires_at).getTime() <= now().getTime()) {
    log.info('connect.expired_invite', 'invite code expired', { project_id: invite.project_id });
    throw new StoreAuthError('invite code is invalid or expired');
  }

  const agent_id = newAgentId();
  const token = newAgentToken();

  await port.insertAgent({
    agent_id,
    project_id: invite.project_id,
    member_id: invite.member_id,
    role_slug: invite.role_slug,
    member_label: sanitizeText(invite.member_label, { field: 'agents.member_label', log }),
    harness,
    token_hash: hashToken(token),
    revoked: 'false',
    created_at: now().toISOString(),
  });
  await port.spendInvite(invite_code);

  log.info('connect.agent_created', 'agent connected', {
    project_id: invite.project_id, agent_id, role_slug: invite.role_slug, harness,
  });

  // The only time the raw token is ever transmitted.
  return json(201, {
    agent_id, project_id: invite.project_id, role_slug: invite.role_slug,
    member_label: invite.member_label, token,
  });
}
