// The CLI bridge: the only moving part between an agent's filesystem and the store.
//
// Deliberately the minimum the vertical slice needs (order 0038) and nothing wider.
//
//   drain  .agentic/outbox.jsonl from outbox.cursor -> publish via the store -> advance cursor
//   feed   store subscription -> .agentic/inbox.jsonl, CONTRACT AND COORDINATION LAYERS ONLY
//
// Publishing goes through the store adapter directly rather than the HTTP API, because the
// Cloud Functions API is not deployed yet and the slice does not need it. That is a deliberate
// narrowing, not an oversight: the slice proves the store, the subscriber, the dashboard wiring
// and the file contract. Auth and the webhook are the next layer, not this one.
//
// Four rules carried in from the other routes, all bought expensively:
//
//   1. Any git we shell out to gets a DEADLINE. A wedged `send-pack` with no timeout makes a
//      daemon sit forever, look healthy, and publish nothing. (No git on this path yet; the
//      rule is recorded where the git call would go, in cli/blackboard.ts, which has it.)
//   2. NEVER sleep on an injected clock in a transport path. Injected clocks are for staleness
//      derivation and the reaper. A retry that slept on a FakeClock nobody advanced turned one
//      transient socket error into a permanent hang. Every wait here uses real timers.
//   3. NEVER hand-walk or stringify an SDK response, and never treat "it did not throw" as
//      success. Every publish below is checked for a real `seq`.
//   4. A POSITIVE CONTROL separates "the platform is broken" from "my reader is broken".
//      `--selftest` writes a known line and asserts it comes back.

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { LAYOUT, appendInbox, readState, writeState } from './agentic.ts';
import { readPending, writeCursor, type OutboxRecord } from './outbox.ts';
import type { Logger } from '../shared/log.ts';
import {
  LAYER_OF,
  type CoordinationStore,
  type EventKind,
  type Snapshot,
} from '../shared/store/types.ts';

export interface BridgeOptions {
  root: string;
  project_id: string;
  /**
   * The seam, and only the seam.
   *
   * Typed as CoordinationStore rather than the Firestore adapter on purpose: this file must not
   * import a backend SDK. It could not, in fact -- firebase-admin lives in firebase/ and does
   * not resolve from cli/, which is the module graph telling the truth about the architecture.
   * The CLI speaks the ten operations and nothing below them.
   */
  store: CoordinationStore;
  log: Logger;
  /** Poll interval for the outbox file. The STORE is push; only the local file is polled. */
  drain_interval_ms?: number;
}

/**
 * Publish one outbox record through the correct store operation.
 *
 * `task_claimed` is not a plain append: a claim is the atomic operation, and routing it through
 * appendEvent would write the event without ever taking the claim. The CLI translates the
 * agent's stated intent into the right primitive — that translation is the CLI's whole job.
 */
export async function publishRecord(
  store: CoordinationStore,
  project_id: string,
  rec: OutboxRecord,
  log: Logger,
): Promise<{ published: boolean; seq: number; note?: string }> {
  const body = rec.body ?? {};
  const task_id = typeof body.task_id === 'string' ? body.task_id : null;
  const agent_id = typeof body.agent_id === 'string' ? body.agent_id : 'agent_local';

  if (rec.kind === 'task_claimed') {
    if (!task_id) return { published: false, seq: 0, note: 'task_claimed without task_id' };
    const res = await store.claimTask(project_id, task_id, agent_id);
    if (!res.ok) {
      // A lost claim is a NORMAL outcome, not an error. It is published in the sense that the
      // intent was resolved, so the cursor advances: re-draining it would only lose again.
      log.info('bridge.claim_lost', 'claim lost to another agent', {
        project_id, task_id, agent_id, owner: res.owner,
      });
      return { published: true, seq: 0, note: `lost to ${res.owner}` };
    }
    const after = await store.readEvents(project_id, 0);
    const claimed = after.events.filter(
      (e) => e.kind === 'task_claimed' && e.body.task_id === task_id,
    );
    const seq = claimed.at(-1)?.seq ?? 0;
    // Rule 3: do not treat "claimTask resolved" as proof an event landed. Check for the event.
    if (seq <= 0) {
      throw new Error(
        `claimTask(${task_id}) reported ok but no task_claimed event is on the ledger. ` +
          'Refusing to advance the cursor on an unverified publish.',
      );
    }
    return { published: true, seq };
  }

  const res = await store.appendEvent(
    project_id,
    {
      layer: LAYER_OF[rec.kind],
      kind: rec.kind,
      actor_type: 'agent',
      actor_id: agent_id,
      body,
    },
    rec.idempotency_key,
  );

  // Rule 3 again: a returned object is not success. A real append has a positive seq.
  if (!res || typeof res.seq !== 'number' || res.seq <= 0) {
    throw new Error(
      `appendEvent(${rec.kind}) returned no usable seq (${JSON.stringify(res)}). ` +
        'Not advancing the cursor.',
    );
  }
  return { published: true, seq: res.seq, note: res.duplicate ? 'duplicate' : undefined };
}

/** Drain the outbox once. Cursor advances only AFTER a verified publish. */
export async function drainOnce(opts: BridgeOptions): Promise<{ published: number; failed: number }> {
  const pending = await readPending(opts.root, opts.log);
  let published = 0;
  let failed = 0;

  for (const rec of pending.sort((a, b) => a.order - b.order)) {
    try {
      const r = await publishRecord(opts.store, opts.project_id, rec, opts.log);
      if (!r.published) {
        opts.log.warn('bridge.unpublishable', 'record cannot ever be published, skipping', {
          kind: rec.kind, note: r.note,
        });
      } else {
        published += 1;
        opts.log.info('bridge.published', 'outbox record published', {
          kind: rec.kind, seq: r.seq, note: r.note ?? '',
        });
      }

      // AFTER the publish, never before. A crash here re-sends, which the idempotency key makes
      // free; a crash the other way round loses the record with nothing anywhere to notice.
      if (rec.source.type === 'jsonl') {
        await writeCursor(opts.root, LAYOUT.outbox_cursor, rec.source.offset + rec.source.length);
      } else {
        await fs.rm(path.join(opts.root, LAYOUT.outbox_spool, rec.source.file), { force: true });
      }
    } catch (err) {
      failed += 1;
      opts.log.warn('bridge.publish_failed', 'publish failed; cursor NOT advanced, will retry', {
        kind: rec.kind, error: String(err),
      });
      break; // stop at the first failure: skipping ahead would leave a hole the cursor cannot express
    }
  }
  return { published, failed };
}

/**
 * Feed the inbox from a live store subscription.
 *
 * THE HUMAN LAYER NEVER REACHES inbox.jsonl. That exclusion is the entire reason agents stay
 * coherent over a long session: `task_progress` narration and heartbeats are worthless to a peer
 * agent and actively cost it context. Filtered here AND at the API, because a leak into the
 * agent's own context file is the one that actually hurts.
 */
export function startInboxFeed(opts: BridgeOptions): () => void {
  let lastSeen = 0;
  let busy = false;

  const pump = async (snap: Snapshot) => {
    if (busy || snap.seq <= lastSeen) return;
    busy = true;
    try {
      const { events } = await opts.store.readEvents(opts.project_id, lastSeen);
      for (const e of events) {
        if (LAYER_OF[e.kind] === 'human') {
          opts.log.info('bridge.human_withheld', 'human-layer event withheld from the inbox', {
            kind: e.kind, seq: e.seq,
          });
          lastSeen = Math.max(lastSeen, e.seq);
          continue;
        }
        const body: Record<string, unknown> = { ...e.body };
        // C7: the agent never sees a commit sha. That is CLI plumbing.
        delete body.commit_sha;
        await appendInbox(
          opts.root,
          { v: '0.2', seq: e.seq, layer: e.layer, kind: e.kind, ts: e.created_at, body },
          opts.log,
        );
        lastSeen = Math.max(lastSeen, e.seq);
        opts.log.info('bridge.inbox_appended', 'inbox line appended', { kind: e.kind, seq: e.seq });
      }
      const st = await readState(opts.root, opts.log);
      await writeState(opts.root, { ...st, last_seen_seq: lastSeen });
    } catch (err) {
      opts.log.warn('bridge.inbox_failed', 'inbox feed failed; will retry on the next frame', {
        error: String(err),
      });
    } finally {
      busy = false;
    }
  };

  return opts.store.subscribe(opts.project_id, 0, (snap) => {
    void pump(snap);
  });
}

/** Run the bridge until interrupted. */
export async function runBridge(opts: BridgeOptions): Promise<void> {
  const interval = opts.drain_interval_ms ?? 1_000;
  const stopInbox = startInboxFeed(opts);
  let running = true;
  const stop = () => {
    running = false;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  opts.log.info('bridge.started', 'bridge running', {
    project_id: opts.project_id,
    root: opts.root,
    drain_interval_ms: interval,
  });

  while (running) {
    await drainOnce(opts);
    // Rule 2: a REAL timer. Never an injected clock on a transport path.
    await new Promise((r) => setTimeout(r, interval));
  }
  stopInbox();
}

// The runnable entry point lives in firebase/bridge-run.ts, because constructing the store
// means importing the backend SDK and that is exactly what must not happen in this file.

export type { EventKind };
