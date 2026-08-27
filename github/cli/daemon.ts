// The `start` loop: drain the outbox, deliver the inbox, heartbeat.
//
// Three properties this file exists to guarantee, all of them checklist rows:
//
//   B6  a crash mid-publish RE-SENDS rather than drops, and the ledger still
//       grows by one -- the cursor advances only after the publish succeeds,
//       and every line carries a stable idempotency key derived from its own
//       content, so the re-send dedupes.
//   B7  offline is NORMAL. The outbox grows, the cursor does not move, and the
//       agent keeps working. Nothing is discarded and nothing throws upward.
//   B8  human-layer events never reach inbox.jsonl.
//   B9  body.local is populated and the file EXISTS before the inbox line is
//       appended -- the agent must never open a path that is not there yet.

import type { CoordinationStore, EventInput, ProjectId } from '../../shared/store/types.ts';
import { LAYER_OF } from '../../shared/store/types.ts';
import { StoreAuthError, isRetryable } from '../../shared/store/errors.ts';
import type { Clock } from '../../shared/clock.ts';
import { systemClock } from '../../shared/clock.ts';
import type { Logger } from '../../shared/log.ts';
import { nullLogger } from '../../shared/log.ts';

import type { AgenticDir, OutboxLine } from './agentic.ts';
import { outboxIdempotencyKey, sanitizeForWire, toInboxLine } from './agentic.ts';
import { createBlackboard, contractPath } from './blackboard.ts';

export interface DaemonOptions {
  store: CoordinationStore;
  agentic: AgenticDir;
  project_id: ProjectId;
  agent_id: string;
  blackboard?: ReturnType<typeof createBlackboard>;
  /** Fetches a published blob by sha so body.local can be written first. */
  fetchPinned?: (commit_sha: string, path: string) => Promise<string>;
  clock?: Clock;
  log?: Logger;
  heartbeat_ms?: number;
}

export interface DrainResult {
  /** Lines that genuinely REACHED the ledger. */
  published: number;
  /** Lines that could not be sent this pass. NOT an error -- see B7. */
  deferred: number;
  /**
   * Lines abandoned: rejected by the store, or an unknown kind.
   *
   * Counted separately from `published` because conflating them is an
   * observation that cannot distinguish success from giving up. It hid a real
   * blackboard bug for a whole demo run: `published: 1` was reported for a
   * contract that never landed, and the test asserting `published === 1`
   * passed while the ledger stayed empty.
   */
  dropped: number;
  cursor_moved: boolean;
}

export function createDaemon(opts: DaemonOptions) {
  const clock = opts.clock ?? systemClock;
  const log = opts.log ?? nullLogger;
  const { agentic, store, project_id, agent_id } = opts;

  /**
   * Publish everything the agent has queued.
   *
   * The cursor advances ONLY past a contiguous run of successes starting at the
   * current cursor. A failure in the middle stops the advance there, so the
   * failed line and everything after it are re-sent next pass -- in order.
   * Advancing past a gap would silently drop a message, which is the failure
   * this whole file is arranged to prevent.
   */
  async function drainOutbox(): Promise<DrainResult> {
    const { lines, spooled } = await agentic.pendingOutbox();
    let published = 0;
    let deferred = 0;
    let dropped = 0;
    let newCursor: number | null = null;
    let stalled = false;

    for (const { line, end_offset } of lines) {
      if (stalled) { deferred += 1; continue; }
      const sent = await publishOne(line);
      if (sent.handled) {
        if (sent.landed) published += 1; else dropped += 1;
        newCursor = end_offset;
      } else {
        // Stop advancing. Everything from here re-sends next pass, in order.
        stalled = true;
        deferred += 1;
      }
    }

    // Spooled payloads are independent files, so one failure does not block the
    // others; each is deleted only after it lands.
    for (const s of spooled) {
      const sent = await publishOne(s.line);
      if (sent.handled) {
        if (sent.landed) published += 1; else dropped += 1;
        const { unlink } = await import('node:fs/promises');
        await unlink(s.path);
      } else {
        deferred += 1;
      }
    }

    if (newCursor !== null) await agentic.writeCursor('outbox', newCursor);
    if (deferred > 0) {
      // Offline is normal, not an error -- but it is never silent.
      log.info('cli.outbox.deferred', 'lines still queued, will retry', {
        project_id, agent_id, deferred, published,
      });
    }
    return { published, deferred, dropped, cursor_moved: newCursor !== null };
  }

  /**
   * `handled` = stop retrying this line. `landed` = it actually reached the
   * ledger. They are NOT the same, and a caller that cannot tell them apart
   * cannot tell a publish from a give-up.
   */
  async function publishOne(line: OutboxLine): Promise<{ handled: boolean; landed: boolean }> {
    try {
      const layer = LAYER_OF[line.kind];
      if (layer === undefined) {
        // An unknown kind is dropped LOUDLY and the line is treated as sent, or
        // it would block the queue forever. Never silently.
        log.error('cli.outbox.unknownKind', 'dropping an outbox line with an unknown kind', {
          project_id, agent_id, kind: line.kind,
        });
        return { handled: true, landed: false };
      }

      let body = line.body;

      // contract_published names a file in the working tree. The CLI commits it,
      // pushes it, and rewrites the body as a POINTER. The agent never handles a
      // commit sha (C1, C2, C7).
      if (line.kind === 'contract_published' && opts.blackboard) {
        body = await publishContract(line);
      }

      const event: EventInput = {
        layer, kind: line.kind, actor_type: 'agent', actor_id: agent_id,
        body: sanitizeBody(body),
      };
      const key = outboxIdempotencyKey(project_id, line);
      const res = await store.appendEvent(project_id, event, key);

      const state = await agentic.readState();
      if (res.seq > state.last_written_seq) {
        await agentic.writeState({ ...state, last_written_seq: res.seq });
      }
      return { handled: true, landed: true };
    } catch (err) {
      if (err instanceof StoreAuthError) {
        // The caller must STOP, not retry. Bubble it: a revoked token is not a
        // transient and pretending otherwise burns quota and hides the problem.
        throw err;
      }
      if (isRetryable(err)) {
        log.info('cli.outbox.retryLater', 'backend unavailable, keeping the line queued', {
          project_id, agent_id, kind: line.kind, error: (err as Error).name,
        });
        return { handled: false, landed: false };
      }
      // A named, non-retryable failure. Log it and treat the line as handled,
      // or one malformed message blocks every later one forever.
      log.error('cli.outbox.rejected', 'line rejected by the store, dropping it', {
        project_id, agent_id, kind: line.kind, error: (err as Error).message,
      });
      return { handled: true, landed: false };
    }
  }

  async function publishContract(line: OutboxLine): Promise<Record<string, unknown>> {
    const b = line.body as { name?: string; version?: number; file?: string; supersedes?: number | null };
    if (typeof b.name !== 'string' || typeof b.version !== 'number' || typeof b.file !== 'string') {
      throw new Error('contract_published needs {name, version, file}');
    }
    const { readFile } = await import('node:fs/promises');
    const contents = await readFile(b.file, 'utf8');
    const path = contractPath(b.name, b.version);
    const published = await opts.blackboard!.publish(
      path, contents, `publish ${b.name} v${b.version}`,
    );
    return {
      name: b.name,
      version: b.version,
      path: published.path,
      commit_sha: published.commit_sha,
      supersedes: b.supersedes ?? (b.version > 1 ? b.version - 1 : null),
    };
  }

  /**
   * Deliver new events into inbox.jsonl.
   *
   * Human-layer events are excluded here, at the delivery boundary, in addition
   * to being refused by appendInbox. Two independent checks on purpose: the
   * protocol calls this its most important rule, and a single filter is one
   * refactor away from being removed.
   */
  async function deliverInbox(): Promise<{ delivered: number; withheld: number }> {
    const state = await agentic.readState();
    const { events } = await store.readEvents(project_id, state.last_seen_seq);
    let delivered = 0;
    let withheld = 0;
    let lastSeq = state.last_seen_seq;

    for (const e of events) {
      lastSeq = Math.max(lastSeq, e.seq);
      if (e.layer === 'human') {
        withheld += 1;
        continue;
      }

      let local: string | undefined;
      const sha = e.body.commit_sha;
      const path = e.body.path;
      if (typeof sha === 'string' && typeof path === 'string' && opts.fetchPinned) {
        // B9: fetch and write the blob BEFORE the line is appended, so the agent
        // can never read a `local` path that does not exist yet.
        try {
          const contents = await opts.fetchPinned(sha, path);
          local = path.startsWith('decisions/')
            ? await agentic.writeDecision(path, contents)
            : await agentic.materialise(path, contents);
        } catch (err) {
          // Could not materialise. Do NOT append a line whose `local` is a lie,
          // and do NOT advance past this event -- retry it next pass.
          log.warn('cli.inbox.materialiseFailed', 'holding an event until its blob is on disk', {
            project_id, seq: e.seq, path, error: (err as Error).message,
          });
          await agentic.writeState({ ...state, last_seen_seq: Math.max(state.last_seen_seq, e.seq - 1) });
          return { delivered, withheld };
        }
      }

      await agentic.appendInbox(toInboxLine(e, local));
      delivered += 1;
    }

    if (lastSeq > state.last_seen_seq) {
      await agentic.writeState({ ...(await agentic.readState()), last_seen_seq: lastSeq });
    }
    if (withheld > 0) {
      log.debug('cli.inbox.withheld', 'human-layer events withheld from the agent', {
        project_id, agent_id, withheld,
      });
    }
    return { delivered, withheld };
  }

  async function beat(status: Parameters<CoordinationStore['heartbeat']>[2], task?: string | null, branch?: string | null): Promise<void> {
    try {
      await store.heartbeat(project_id, agent_id, status, task ?? null, branch ?? null);
    } catch (err) {
      if (err instanceof StoreAuthError) throw err;
      // A missed heartbeat is a presence blip, not a reason to stop working.
      log.debug('cli.heartbeat.failed', 'heartbeat failed, continuing', {
        project_id, agent_id, error: (err as Error).name,
      });
    }
  }

  /** One full pass. Returns counts so a caller can assert rather than infer. */
  async function tick(status: Parameters<CoordinationStore['heartbeat']>[2] = 'working') {
    const state = await agentic.readState();
    await beat(status, null, null);
    const out = await drainOutbox();
    const inn = await deliverInbox();
    return { ...out, ...inn, last_seen_seq: state.last_seen_seq };
  }

  let timer: ReturnType<typeof setInterval> | null = null;

  function start(): () => void {
    const every = opts.heartbeat_ms ?? 20_000;
    const run = () => { void tick().catch((err) => {
      log.error('cli.tick.failed', 'daemon pass failed', { error: (err as Error).message });
    }); };
    run();
    timer = setInterval(run, every);
    if (typeof timer.unref === 'function') timer.unref();
    return () => { if (timer) clearInterval(timer); timer = null; };
  }

  return { drainOutbox, deliverInbox, beat, tick, start };
}

function sanitizeBody(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    out[k] = typeof v === 'string' ? sanitizeForWire(v) : v;
  }
  return out;
}
