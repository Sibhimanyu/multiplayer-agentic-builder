// Cron function: release claims whose owning agent is gone.
//
// Thin by design. Every decision lives in catalyst/lib/reaper.ts, which is pure
// and tested; this file only turns SDK calls into the ports that module expects.
//
// A cron function is invoked on a schedule with no request and no caller, so
// there is nobody to return an error to. That shapes two things:
//
//  - Nothing throws out of the handler. A cron function that throws is a silent
//    failure with a stack trace nobody reads, and the next scheduled run is the
//    only feedback. Failures are counted and logged.
//  - Both ends log a heartbeat. Cron and Event functions are SILENTLY TERMINATED
//    on timeout with no line saying so, and a matched start/end pair is the only
//    way to tell a kill from a clean pass that found nothing.

import type { ProjectId } from '../../shared/store/types.ts';
import { CLAIM_TIMEOUT_MS } from '../../shared/store/types.ts';
import type { Logger } from '../../shared/log.ts';
import { fromCatalystDatetime, toCatalystDatetime } from '../../catalyst/lib/datetime.ts';
import { readMaxSeq, selectMaxSeq, unwrapRows } from '../../catalyst/lib/zcql.ts';
import { allocateSeqAndInsert } from '../../catalyst/lib/seq.ts';
import { toDuplicateValueError } from '../../catalyst/lib/duplicate.ts';
import { runReaper } from '../../catalyst/lib/reaper.ts';
import type { AgentLiveness, ReapableClaim, ReaperPort } from '../../catalyst/lib/reaper.ts';
import { eventIdFor, dedupeKeyFor } from '../append/index.ts';
import { presenceKey, PRESENCE_SEGMENT } from '../presence/index.ts';

interface CronApp {
  datastore(): {
    table(name: string): {
      insertRow(row: Record<string, unknown>): Promise<unknown>;
      deleteRow(rowId: string): Promise<unknown>;
    };
  };
  zcql(): { executeZCQLQuery(query: string): Promise<unknown[]> };
  cache(): {
    segment(name?: string): {
      get(key: string): Promise<unknown>;
      put(key: string, value: string, expiryInHours?: number): Promise<unknown>;
    };
  };
}

export interface CronOps { selects: number; inserts: number; deletes: number; cache_gets: number }

export function makeReaperPort(app: CronApp, log: Logger, ops: CronOps): ReaperPort {
  const query = async (zcql: string): Promise<unknown[]> => {
    ops.selects += 1;
    return app.zcql().executeZCQLQuery(zcql);
  };

  return {
    listClaims: async (limit) => {
      const rows = unwrapRows<Record<string, unknown>>(await query(
        `SELECT ROWID, claim_key, project_id, task_id, agent_id, claimed_at FROM task_claims` +
        ` ORDER BY claimed_at LIMIT 0, ${limit}`), 'task_claims');
      return rows.map((r): ReapableClaim => ({
        rowid: String(r.ROWID),
        claim_key: String(r.claim_key),
        project_id: String(r.project_id),
        task_id: String(r.task_id),
        agent_id: String(r.agent_id),
        // Stored in the platform's format; the reaper reasons in RFC3339.
        claimed_at: safeDecode(String(r.claimed_at)),
      }));
    },

    listLiveness: async (project_ids) => {
      const out: AgentLiveness[] = [];
      const segment = app.cache().segment(PRESENCE_SEGMENT);

      for (const project_id of project_ids) {
        const rows = unwrapRows<Record<string, unknown>>(await query(
          `SELECT agent_id, revoked FROM agents WHERE project_id = '${escape(project_id)}'` +
          ` LIMIT 0, 100`), 'agents');

        for (const r of rows) {
          const agent_id = String(r.agent_id);
          ops.cache_gets += 1;
          const raw = await segment.get(presenceKey(project_id, agent_id));
          out.push({
            agent_id,
            last_seen_ms: lastSeenFrom(raw),
            // Raw on purpose: readBool decides, inside the reaper.
            revoked: r.revoked,
          });
        }
      }
      return out;
    },

    deleteClaim: async (rowid) => {
      ops.deletes += 1;
      await app.datastore().table('task_claims').deleteRow(rowid);
    },

    appendUnblocked: async (project_id: ProjectId, body, idempotency_key) => {
      // The reaper writes the same two-row shape as any other append, but cannot
      // reuse handleAppend: that resolves a principal from a token and a
      // scheduled run has none. actor_type 'system' exists for exactly this.
      //
      // It DOES reuse allocateSeqAndInsert. An earlier version hand-rolled its
      // own MAX(seq) read and got it wrong -- see the note on readMaxSeq below --
      // and without the allocator's retry loop the mistake surfaced as a bare
      // DUPLICATE_VALUE instead of being absorbed.
      const dedupe_key = dedupeKeyFor(project_id, idempotency_key);
      const created_at = toCatalystDatetime(new Date().toISOString());

      const { seq } = await allocateSeqAndInsert<void>({
        // readMaxSeq, NOT a local reimplementation. ZCQL IGNORES the column alias
        // in an aggregate: `SELECT MAX(seq) AS max_seq` comes back keyed by the
        // RAW EXPRESSION, {"events":{"MAX(seq)":"101"}}, and the value is a
        // STRING. Reading `max_seq` yields undefined, which defaults to 0, which
        // allocates seq 1 and collides forever.
        maxSeq: async () => readMaxSeq(await query(selectMaxSeq())),
        insert: async (allocated) => {
          ops.inserts += 1;
          try {
            await app.datastore().table('events').insertRow({
              seq: allocated, event_id: eventIdFor(allocated), project_id,
              layer: 'contract', kind: 'task_unblocked',
              actor_type: 'system', actor_id: 'system:reaper',
              created_at, dedupe_key, body: JSON.stringify(body),
            });
          } catch (err) {
            // The allocator needs the typed error to know whether to retry.
            throw toDuplicateValueError(err) ?? err;
          }
        },
      }, { log, op: 'reaper.append' });

      ops.inserts += 1;
      try {
        await app.datastore().table('request_dedupe').insertRow({
          dedupe_key, idempotency_key, project_id, seq,
          event_id: eventIdFor(seq), created_at,
        });
      } catch (err) {
        const dup = toDuplicateValueError(err);
        // A previous pass already recorded this reap. The event is in the ledger
        // either way, so the release can proceed.
        if (dup && dup.column === 'dedupe_key') {
          log.info('reaper.dedupe_already_recorded', 'this reap was already recorded', {
            project_id, dedupe_key,
          });
          return;
        }
        throw dup ?? err;
      }
    },
  };

  function escape(v: string): string { return v.replace(/'/g, "''"); }

  /** A claim whose timestamp will not decode is left as-is; the reaper ages it
   * as infinitely old rather than treating it as new. */
  function safeDecode(v: string): string {
    try {
      return fromCatalystDatetime(v);
    } catch {
      log.warn('reaper.undecodable_claimed_at', 'claimed_at did not decode, claim will be aged as stale', {
        raw: v,
      });
      return 'unparseable';
    }
  }

  function lastSeenFrom(raw: unknown): number | null {
    const text = normalise(raw);
    if (text === null) return null;
    try {
      const v = JSON.parse(text) as { at_ms?: unknown };
      return typeof v.at_ms === 'number' && Number.isFinite(v.at_ms) ? v.at_ms : null;
    } catch {
      return null;
    }
  }

  /** Cache returns assorted shapes, and delete() leaves a null value behind. */
  function normalise(v: unknown): string | null {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') return v === '' ? null : v;
    if (typeof v === 'object') {
      const holder = v as { cache_value?: unknown; value?: unknown };
      const inner = holder.cache_value ?? holder.value;
      if (inner === null || inner === undefined) return null;
      return typeof inner === 'string' ? inner : JSON.stringify(inner);
    }
    return String(v);
  }
}

/** Cache key holding the last pass summary. See the note in `reap`. */
export const REAPER_STATUS_KEY = 'reaper:last_pass';

/**
 * Entry point. Never throws: a job function has no caller to answer.
 *
 * WHY THE SUMMARY GOES INTO CACHE. A deployed function's console output is not
 * retrievable -- the Get_Logs API returns an empty array for this project's
 * functions, and a failed job reports only `response_code: "Code_Exception"` with
 * no message. So a pass that silently does nothing is indistinguishable from a
 * pass that had nothing to do. Writing the summary to a Cache key that /health
 * can read is the only channel that actually reports back.
 */
export async function reap(app: CronApp, log: Logger): Promise<CronOps & { reaped: number }> {
  const ops: CronOps = { selects: 0, inserts: 0, deletes: 0, cache_gets: 0 };
  let summary: Record<string, unknown>;

  try {
    const result = await runReaper(makeReaperPort(app, log, ops), Date.now(), log, CLAIM_TIMEOUT_MS);
    log.info('reaper.ops', 'operations consumed by this pass', { ...ops, ...result });
    summary = { at: new Date().toISOString(), ok: true, ...ops, ...result };
    await publish(app, summary, log);
    return { ...ops, reaped: result.reaped };
  } catch (err) {
    const detail = {
      error: err instanceof Error ? err.name : typeof err,
      message: err instanceof Error ? err.message : String(err),
      // The SDK rejects with a plain object, so `message` alone can be empty.
      code: (err as { code?: string })?.code,
      backend_message: (err as { backend_message?: string })?.backend_message,
      column: (err as { column?: string })?.column,
    };
    log.error('reaper.pass_failed', 'reaper pass failed entirely', { ...detail, ...ops });
    summary = { at: new Date().toISOString(), ok: false, ...detail, ...ops };
    await publish(app, summary, log);
    return { ...ops, reaped: 0 };
  }
}

/** Best-effort. A failure to publish the summary must not mask the pass result. */
async function publish(app: CronApp, summary: Record<string, unknown>, log: Logger): Promise<void> {
  try {
    await app.cache().segment(PRESENCE_SEGMENT).put(REAPER_STATUS_KEY, JSON.stringify(summary), 24);
  } catch (err) {
    log.warn('reaper.status_publish_failed', 'could not publish the pass summary', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
