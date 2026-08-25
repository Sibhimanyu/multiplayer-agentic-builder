// Outbox drain. The at-least-once half of the file contract.
//
// The rule that makes this correct: the cursor advances ONLY after a successful publish. A
// crash therefore re-sends rather than drops, which is why appendEvent requires an idempotency
// key. Getting the ordering backwards silently loses an agent's work, and it is invisible
// until the day it matters.
//
// The subtle part is that "re-send" must produce the SAME idempotency key it would have used
// the first time, or at-least-once becomes at-least-twice. The key cannot come from the agent
// (the agent does not write one) and it cannot be random (a restart would generate a new one).
// So it is derived: sha256 of the payload bytes plus the byte offset the line sits at. Stable
// across restarts, unique per line, and two genuinely identical progress reports at different
// offsets still get distinct keys.

import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { LAYOUT } from './agentic.ts';
import { LAYER_OF, type EventKind, type Logger } from '../shared/store/types.ts';

/** POSIX guarantees a single O_APPEND write is not interleaved only below one page. */
export const SPOOL_THRESHOLD_BYTES = 4096;

export interface OutboxRecord {
  /** Stable across restarts. Used as the idempotency key. */
  idempotency_key: string;
  kind: EventKind;
  body: Record<string, unknown>;
  /** Where it came from, for logging and for the spool cleanup. */
  source: { type: 'jsonl'; offset: number; length: number } | { type: 'spool'; file: string };
  /** mtime for spool files, cursor order for jsonl. Drain is ordered by this. */
  order: number;
}

const enc = new TextEncoder();

export const keyFor = (payload: string, offset: number): string =>
  `ob:${createHash('sha256').update(`${offset}:${payload}`, 'utf8').digest('hex').slice(0, 40)}`;

/** Read the cursor. A missing or corrupt cursor means "start from zero", loudly. */
export async function readCursor(root: string, rel: string, log: Logger): Promise<number> {
  try {
    const raw = await fs.readFile(path.join(root, rel), 'utf8');
    const n = Number(raw.trim());
    if (!Number.isFinite(n) || n < 0) {
      log.warn('cursor file is not a non-negative number, resetting to 0', { file: rel, raw });
      return 0;
    }
    return n;
  } catch (err) {
    const e = err as { code?: string };
    if (e.code !== 'ENOENT') log.warn('cursor unreadable, resetting to 0', { file: rel, error: String(err) });
    return 0;
  }
}

/**
 * Write the cursor via temp-file-and-rename.
 *
 * A partial write to the cursor is worse than a crash before writing it: a truncated "12" from
 * "1234" would silently rewind the outbox and re-send hundreds of lines. rename() on one
 * filesystem is atomic, so the cursor is either the old value or the new one.
 */
export async function writeCursor(root: string, rel: string, offset: number): Promise<void> {
  const abs = path.join(root, rel);
  const tmp = path.join(path.dirname(abs), `.tmp-cursor-${randomUUID()}`);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(tmp, `${offset}\n`, 'utf8');
  await fs.rename(tmp, abs);
}

/**
 * Everything unpublished, from both sources, in order.
 *
 * jsonl lines and spool files are drained together, ordered by mtime as the contract says.
 * Within the jsonl the byte offset is the order.
 */
export async function readPending(root: string, log: Logger): Promise<OutboxRecord[]> {
  const out: OutboxRecord[] = [];
  const cursor = await readCursor(root, LAYOUT.outbox_cursor, log);

  // ---- outbox.jsonl from the cursor to EOF ----
  const jsonlPath = path.join(root, LAYOUT.outbox);
  let raw = '';
  try {
    const buf = await fs.readFile(jsonlPath);
    if (cursor > buf.byteLength) {
      // The outbox shrank. Either it was truncated by hand or replaced. Re-reading from zero
      // is safe (idempotency keys dedupe) and losing the tail is not.
      log.warn('outbox cursor is past EOF, re-reading from the start', {
        cursor,
        size: buf.byteLength,
      });
      raw = buf.toString('utf8');
    } else {
      raw = buf.subarray(cursor).toString('utf8');
    }
  } catch (err) {
    const e = err as { code?: string };
    if (e.code !== 'ENOENT') throw err;
  }

  let offset = cursor;
  for (const chunk of raw.split('\n')) {
    const lineBytes = enc.encode(`${chunk}\n`).byteLength;
    const lineOffset = offset;
    offset += lineBytes;
    const text = chunk.trim();
    if (text === '') continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // A malformed line must not block every line behind it, and must not be silently
      // skipped either. Reported, and the drain continues past it.
      log.warn('outbox line is not valid JSON, skipping it', {
        offset: lineOffset,
        preview: text.slice(0, 120),
      });
      continue;
    }

    const kind = parsed.kind;
    if (typeof kind !== 'string' || !(kind in LAYER_OF)) {
      log.warn('outbox line has an unknown kind, skipping it', { offset: lineOffset, kind: String(kind) });
      continue;
    }

    out.push({
      idempotency_key: keyFor(text, lineOffset),
      kind: kind as EventKind,
      body: (parsed.body ?? {}) as Record<string, unknown>,
      source: { type: 'jsonl', offset: lineOffset, length: lineBytes },
      order: lineOffset,
    });
  }

  // ---- outbox.d/ spool, ordered by mtime ----
  const spoolDir = path.join(root, LAYOUT.outbox_spool);
  let names: string[] = [];
  try {
    names = await fs.readdir(spoolDir);
  } catch (err) {
    const e = err as { code?: string };
    if (e.code !== 'ENOENT') throw err;
  }

  const spooled: { file: string; mtime: number; text: string }[] = [];
  for (const name of names) {
    // Skip in-progress writes: the writer creates .tmp-<uuid> then renames, so a reader must
    // never observe a partial file.
    if (name.startsWith('.tmp-')) continue;
    if (!name.endsWith('.json')) {
      log.warn('unexpected file in the outbox spool, ignoring', { file: name });
      continue;
    }
    const abs = path.join(spoolDir, name);
    try {
      const [stat, text] = await Promise.all([fs.stat(abs), fs.readFile(abs, 'utf8')]);
      spooled.push({ file: name, mtime: stat.mtimeMs, text });
    } catch (err) {
      log.warn('spool file unreadable, leaving it in place', { file: name, error: String(err) });
    }
  }
  spooled.sort((a, b) => a.mtime - b.mtime || a.file.localeCompare(b.file));

  for (const s of spooled) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(s.text) as Record<string, unknown>;
    } catch {
      log.warn('spool file is not valid JSON, leaving it in place', { file: s.file });
      continue;
    }
    const kind = parsed.kind;
    if (typeof kind !== 'string' || !(kind in LAYER_OF)) {
      log.warn('spool file has an unknown kind, leaving it in place', { file: s.file, kind: String(kind) });
      continue;
    }
    out.push({
      // The filename is a uuid the agent generated, so it is already stable across restarts —
      // no offset needed.
      idempotency_key: `ob:spool:${s.file.replace(/\.json$/, '')}`,
      kind: kind as EventKind,
      body: (parsed.body ?? {}) as Record<string, unknown>,
      source: { type: 'spool', file: s.file },
      order: s.mtime,
    });
  }

  return out;
}

export interface DrainResult {
  published: number;
  duplicates: number;
  /** Records left unpublished, e.g. because the backend went offline mid-drain. */
  remaining: number;
  cursor_before: number;
  cursor_after: number;
}

export type Publisher = (
  rec: OutboxRecord,
) => Promise<{ seq: number; duplicate: boolean }>;

/**
 * Publish everything pending, then advance the cursor.
 *
 * Ordering, and why it is this way round:
 *
 *   1. publish record
 *   2. only if it succeeded, advance the cursor past it
 *
 * A crash between 1 and 2 re-sends the record on the next run, and the store's idempotency key
 * makes the re-send a no-op returning the original seq. A crash after advancing but before
 * publishing would LOSE the record, with nothing anywhere to notice. So the cursor trails the
 * publish, always.
 *
 * The cursor advances per-record rather than once at the end, so an outage halfway through a
 * fifty-line drain does not re-send the first twenty-five.
 */
export async function drain(
  root: string,
  publish: Publisher,
  log: Logger,
  opts: { onOffline?: (err: unknown) => void } = {},
): Promise<DrainResult> {
  const pending = await readPending(root, log);
  pending.sort((a, b) => a.order - b.order);

  const cursor_before = await readCursor(root, LAYOUT.outbox_cursor, log);
  let cursor = cursor_before;
  let published = 0;
  let duplicates = 0;
  let stopped = false;

  for (const rec of pending) {
    if (stopped) break;
    try {
      const r = await publish(rec);
      if (r.duplicate) duplicates++;
      else published++;

      if (rec.source.type === 'jsonl') {
        // Advance past this line only now.
        cursor = rec.source.offset + rec.source.length;
        await writeCursor(root, LAYOUT.outbox_cursor, cursor);
      } else {
        // The spool has no cursor: the file's existence IS the queue, so publishing means
        // deleting. Delete after the publish, for the same reason the cursor trails it.
        await fs.rm(path.join(root, LAYOUT.outbox_spool, rec.source.file), { force: true });
      }
    } catch (err) {
      // Offline is normal, not an error: the agent keeps working and the outbox grows. Stop
      // the drain here rather than skipping ahead — skipping would publish out of order and
      // leave a hole the cursor cannot represent.
      opts.onOffline?.(err);
      log.info('drain stopped, will resume', {
        reason: String(err),
        remaining: pending.length - published - duplicates,
      });
      stopped = true;
    }
  }

  return {
    published,
    duplicates,
    remaining: pending.length - published - duplicates,
    cursor_before,
    cursor_after: cursor,
  };
}

/**
 * Append one event to the outbox the way an agent would.
 *
 * Used by `builder report` and by tests. Enforces the 4 KiB rule: over threshold goes to the
 * spool via temp-file-and-rename, never appended (B5).
 */
export async function appendOutbox(
  root: string,
  event: { kind: EventKind; body: Record<string, unknown> },
  log: Logger,
): Promise<{ target: 'jsonl' | 'spool'; bytes: number; file?: string }> {
  const line = JSON.stringify({
    v: '0.2',
    kind: event.kind,
    ts: new Date().toISOString(),
    body: event.body,
  });
  const bytes = enc.encode(`${line}\n`).byteLength;

  if (bytes > SPOOL_THRESHOLD_BYTES) {
    const id = randomUUID();
    const dir = path.join(root, LAYOUT.outbox_spool);
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.tmp-${id}`);
    const final = path.join(dir, `${id}.json`);
    await fs.writeFile(tmp, line, 'utf8');
    // rename() on one filesystem is atomic, so a reader never sees a partial file.
    await fs.rename(tmp, final);
    log.info('outbox payload spooled', { bytes, file: `${id}.json`, kind: event.kind });
    return { target: 'spool', bytes, file: `${id}.json` };
  }

  const abs = path.join(root, LAYOUT.outbox);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.appendFile(abs, `${line}\n`, 'utf8');
  return { target: 'jsonl', bytes };
}

/** Does the tree exist? Used by every command that is not `connect`. */
export async function isConnected(root: string): Promise<boolean> {
  try {
    await fs.access(path.join(root, LAYOUT.project), constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
