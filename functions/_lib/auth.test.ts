// Auth resolution, and the non-negotiables it enforces:
//   H3 agents cannot merge, verified by attempting it
//   H4 agent_id is never accepted from the client, verified by forging one

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  hashToken, requireMergePermission, requireProject, resolvePrincipal, tokenHashMatches,
} from './auth.ts';
import type { AgentRow, AuthPort, RoleRow } from './auth.ts';
import { rejectServerOwnedFields, bearerToken, errorResponse, withCors } from './http.ts';
import { HttpError } from './http.ts';
import { StoreAuthError, StoreBusyError, StoreError, StoreOfflineError } from '../../shared/store/errors.ts';

const TOKEN = 'agt_live_2f8c1d4e9b7a6350';

function agentRow(over: Partial<AgentRow> = {}): AgentRow {
  return {
    agent_id: 'agent_be01', project_id: 'proj_inventory', member_id: 'mem_1',
    role_slug: 'backend', member_label: 'Bea Backend', harness: 'claude-code',
    token_hash: hashToken(TOKEN),
    // Data Store hands booleans back as STRINGS. The fixtures use strings on
    // purpose -- a fixture using real booleans would hide the bug this guards.
    revoked: 'false',
    ...over,
  };
}

function roleRow(over: Partial<RoleRow> = {}): RoleRow {
  return {
    role_key: 'proj_inventory:backend', project_id: 'proj_inventory', role_slug: 'backend',
    label: 'Backend Builder', can_merge: 'false', ...over,
  };
}

function port(agent: AgentRow | null, role: RoleRow | null = roleRow()): AuthPort {
  return {
    findAgentByTokenHash: async (h) => (agent && agent.token_hash === h ? agent : null),
    findRole: async () => role,
  };
}

describe('token resolution', () => {
  test('a valid token resolves to a principal', async () => {
    const p = await resolvePrincipal(port(agentRow()), TOKEN);
    assert.equal(p.agent_id, 'agent_be01');
    assert.equal(p.project_id, 'proj_inventory');
    assert.equal(p.role_slug, 'backend');
    assert.equal(p.can_merge, false);
  });

  test('a missing token is StoreAuthError, so the CLI stops', async () => {
    await assert.rejects(() => resolvePrincipal(port(agentRow()), null), StoreAuthError);
    await assert.rejects(() => resolvePrincipal(port(agentRow()), ''), StoreAuthError);
  });

  test('an unknown token is StoreAuthError', async () => {
    await assert.rejects(() => resolvePrincipal(port(agentRow()), 'agt_wrong'), StoreAuthError);
  });

  test('A14: a revoked token is StoreAuthError even though revoked is the STRING "true"', async () => {
    await assert.rejects(
      () => resolvePrincipal(port(agentRow({ revoked: 'true' })), TOKEN),
      StoreAuthError,
    );
  });

  test('the string "false" does NOT revoke -- the exact bug readBool exists for', async () => {
    // Boolean("false") is true. A direct read here would lock out every agent.
    const p = await resolvePrincipal(port(agentRow({ revoked: 'false' })), TOKEN);
    assert.equal(p.agent_id, 'agent_be01');
  });

  test('a token whose role vanished fails closed', async () => {
    await assert.rejects(() => resolvePrincipal(port(agentRow(), null), TOKEN), StoreAuthError);
  });

  test('the raw token is never compared or stored -- only its hash', () => {
    const row = agentRow();
    assert.equal(row.token_hash.length, 64);
    assert.notEqual(row.token_hash, TOKEN);
    assert.equal(hashToken(TOKEN), row.token_hash);
  });

  test('hash comparison is constant-time and length-guarded', () => {
    assert.equal(tokenHashMatches(hashToken(TOKEN), hashToken(TOKEN)), true);
    assert.equal(tokenHashMatches(hashToken(TOKEN), hashToken('other')), false);
    // Must not throw on a length mismatch the way timingSafeEqual would.
    assert.equal(tokenHashMatches('short', hashToken(TOKEN)), false);
  });
});

describe('H3 agents cannot merge, verified by attempting it', () => {
  test('a backend role with can_merge "false" is refused', async () => {
    const p = await resolvePrincipal(port(agentRow(), roleRow({ can_merge: 'false' })), TOKEN);
    assert.throws(() => requireMergePermission(p), StoreAuthError);
  });

  test('a role with can_merge absent is refused -- fail closed', async () => {
    const p = await resolvePrincipal(port(agentRow(), roleRow({ can_merge: undefined })), TOKEN);
    assert.equal(p.can_merge, false);
    assert.throws(() => requireMergePermission(p), StoreAuthError);
  });

  test('only an explicitly granted role may merge', async () => {
    const p = await resolvePrincipal(
      port(agentRow({ role_slug: 'integrator' }), roleRow({ role_slug: 'integrator', can_merge: 'true' })),
      TOKEN,
    );
    assert.doesNotThrow(() => requireMergePermission(p));
  });

  test('the STRING "false" does not grant merge', async () => {
    // The headline failure: truthy "false" would let every agent merge.
    for (const value of ['false', 'FALSE', '0', '', 'no', undefined, null]) {
      const p = await resolvePrincipal(port(agentRow(), roleRow({ can_merge: value })), TOKEN);
      assert.equal(p.can_merge, false, `can_merge ${JSON.stringify(value)} must not grant merge`);
    }
  });
});

describe('H4 agent_id is never accepted from the client, verified by forging one', () => {
  test('a forged agent_id in the body is REJECTED, not ignored', () => {
    assert.throws(
      () => rejectServerOwnedFields({ task_id: 'task_a', agent_id: 'agent_someone_else' }),
      (err: unknown) => {
        assert.ok(err instanceof HttpError);
        assert.equal((err as HttpError).code, 'SERVER_OWNED_FIELD');
        return true;
      },
    );
  });

  test('other server-owned fields are rejected too', () => {
    for (const field of ['actor_id', 'seq', 'event_id', 'created_at']) {
      assert.throws(() => rejectServerOwnedFields({ [field]: 'x' }), HttpError, `${field} must be rejected`);
    }
  });

  test('an honest body passes', () => {
    assert.doesNotThrow(() => rejectServerOwnedFields({ task_id: 'task_a', kind: 'task_claimed' }));
  });

  test('a token scoped to another project cannot act cross-project', async () => {
    const p = await resolvePrincipal(port(agentRow()), TOKEN);
    assert.doesNotThrow(() => requireProject(p, 'proj_inventory'));
    assert.throws(() => requireProject(p, 'proj_someone_else'), StoreAuthError);
  });

  test('no handler reads agent_id out of a request body', () => {
    // Mechanical guard: the forgery test above only proves the helper works.
    // This proves no handler bypasses it.
    const dir = new URL('../', import.meta.url).pathname;
    const offenders: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '_lib') continue;
      const file = join(dir, entry.name, 'index.ts');
      let src: string;
      try { src = readFileSync(file, 'utf8'); } catch { continue; }
      if (/body\s*[.[]\s*['"]?agent_id/.test(src)) offenders.push(entry.name);
    }
    assert.deepEqual(offenders, [], `these handlers read agent_id from the body: ${offenders.join(', ')}`);
  });
});

describe('error mapping makes the client do the right thing', () => {
  test('StoreAuthError -> 401, so the CLI stops rather than retrying', () => {
    const res = errorResponse(new StoreAuthError());
    assert.equal(res.status, 401);
    assert.equal((res.body as { code: string }).code, 'STORE_AUTH');
  });

  test('StoreBusyError -> 429 with Retry-After, so the CLI backs off', () => {
    const res = errorResponse(new StoreBusyError('slow down', { retry_after_ms: 2500 }));
    assert.equal(res.status, 429);
    assert.equal(res.headers['Retry-After'], '3');
    assert.equal((res.body as { retry_after_ms: number }).retry_after_ms, 2500);
  });

  test('StoreOfflineError -> 503, so the CLI queues to its outbox', () => {
    assert.equal(errorResponse(new StoreOfflineError()).status, 503);
  });

  test('StoreError -> 400, not 500', () => {
    assert.equal(errorResponse(new StoreError('bad cursor')).status, 400);
  });

  test('only a genuinely unexpected error is a 500', () => {
    const res = errorResponse(new TypeError('undefined is not a function'));
    assert.equal(res.status, 500);
    assert.equal((res.body as { code: string }).code, 'UNEXPECTED');
  });
});

describe('request helpers', () => {
  test('a bearer token is read from the Authorization header only', () => {
    const req = { method: 'POST', path: '/claim', headers: { authorization: `Bearer ${TOKEN}` } };
    assert.equal(bearerToken(req), TOKEN);
    assert.equal(bearerToken({ ...req, headers: {} }), null);
    assert.equal(bearerToken({ ...req, headers: { authorization: TOKEN } }), null, 'must require the Bearer scheme');
  });

  test('CORS never duplicates an origin Catalyst already set', () => {
    // Two values in Access-Control-Allow-Origin is a hard browser failure.
    const already = { 'access-control-allow-origin': 'https://dash.example' };
    const out = withCors({}, 'https://dash.example', already);
    assert.equal('Access-Control-Allow-Origin' in out, false, 'must not add a second origin header');
    const fresh = withCors({}, 'https://dash.example', {});
    assert.equal(fresh['Access-Control-Allow-Origin'], 'https://dash.example');
  });
});
