// Durable-write sanitisation, shared by every adapter.
//
// Why this exists: Catalyst Data Store silently stores 4-byte UTF-8 (all emoji,
// astral-plane CJK) as '?'. Firestore stores it faithfully. If each build behaved
// naturally the two ledgers would differ and the bake-off would be measuring
// encoding, not platforms. So BOTH strip, here, before every durable write.
//
// The column limits are Catalyst's, applied to both builds for the same reason:
//   varchar  255    -- hard cap, SILENTLY clamped. Never used for user text.
//   text     10,000 -- hard cap. Contracts are pointers, never column values.
//
// Everything dropped is logged (non-negotiable H1). Nothing truncates silently.

import type { Logger } from './log.ts';
import { nullLogger } from './log.ts';

export const VARCHAR_MAX = 255;
export const TEXT_MAX = 10_000;

/**
 * Code points that do not survive a Catalyst durable write, or that render as
 * emoji and so are stripped for parity:
 *   - anything above the BMP (U+10000+) => 4-byte UTF-8 => stored as '?'
 *   - Extended_Pictographic (covers BMP emoji like U+2600, U+2714)
 *   - emoji glue: ZWJ, variation selectors, combining keycap
 */
const ASTRAL = /[\u{10000}-\u{10FFFF}]/gu;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/gu;
const EMOJI_GLUE = /[‍︎️⃣]/gu;

export interface StripResult {
  value: string;
  /** Count of code points removed. 0 means the input was already clean. */
  removed: number;
}

/** Remove every code point that would not survive a durable write. */
export function stripUnstorable(input: string): StripResult {
  const before = [...input].length;
  const value = input.replace(ASTRAL, '').replace(PICTOGRAPHIC, '').replace(EMOJI_GLUE, '');
  return { value, removed: before - [...value].length };
}

/** True when the input is already safe to store. Cheap pre-check for callers. */
export function isStorable(input: string): boolean {
  return stripUnstorable(input).removed === 0;
}

export interface SanitizeOptions {
  /** Column/field name, for the log line. */
  field: string;
  /** Column capacity. Defaults to the `text` cap. */
  max?: number;
  log?: Logger;
}

/**
 * Strip unstorable code points, then clamp to the column cap. Both actions are
 * logged with the field name so a dropped character is always traceable.
 */
export function sanitizeText(input: string, opts: SanitizeOptions): string {
  const log = opts.log ?? nullLogger;
  const max = opts.max ?? TEXT_MAX;

  const stripped = stripUnstorable(input);
  if (stripped.removed > 0) {
    log.warn('sanitize.stripped', 'removed code points that do not survive a durable write', {
      field: opts.field, removed: stripped.removed, kept_chars: [...stripped.value].length,
    });
  }

  const chars = [...stripped.value];
  if (chars.length <= max) return stripped.value;

  log.warn('sanitize.clamped', 'value exceeded the column cap and was clamped', {
    field: opts.field, max, was: chars.length, dropped: chars.length - max,
  });
  return chars.slice(0, max).join('');
}

/**
 * Sanitise every string in an event body, recursively. Returns a new object;
 * the input is never mutated. Keys are sanitised too -- an emoji in a key would
 * collide with another key once the backend rewrote it to '?'.
 */
export function sanitizeBody<T>(body: T, log: Logger = nullLogger, path = 'body'): T {
  if (typeof body === 'string') {
    return sanitizeText(body, { field: path, log }) as unknown as T;
  }
  if (Array.isArray(body)) {
    return body.map((v, i) => sanitizeBody(v, log, `${path}[${i}]`)) as unknown as T;
  }
  if (body !== null && typeof body === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      const key = sanitizeText(k, { field: `${path}.<key>`, max: VARCHAR_MAX, log });
      out[key] = sanitizeBody(v, log, `${path}.${key}`);
    }
    return out as unknown as T;
  }
  // number | boolean | null | undefined | bigint | symbol -- nothing to strip.
  return body;
}

/**
 * Read a boolean that a backend may have stored as a string.
 *
 * Catalyst Data Store returns booleans as strings, and `Boolean("false")` is
 * true in JS. A truthy `can_merge` is an agent merging when it must not, so this
 * is never inlined at a call site.
 */
export function readBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.trim().toLowerCase() === 'true';
  if (typeof v === 'number') return v === 1;
  return false;
}
