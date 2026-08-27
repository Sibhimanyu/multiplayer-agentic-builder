// Ref naming, and the two invariants the whole route rests on.
//
// Route G gets per-project scoping FOR FREE, because the ref path IS the scope.
// That is worth stating plainly, because it is where this route diverges from
// the other two: mandatory behaviour 2 exists on Catalyst because `is_unique` is
// global to the TABLE, so every per-project constraint needs a composite key
// column. Here `refs/agentic/<project>/claims/<task>` cannot collide with
// another project's identically-named task -- different path, different ref.
//
// The checklist still requires a composite-key rule, because the dedupe key is
// CLIENT-supplied (MB1a) and a client-supplied string cannot be trusted inside
// a ref path. We take rule B, hash-each-part: fixed-length hex operands, so the
// "a:b"+"c" vs "a"+"b:c" collision class cannot exist rather than needing to be
// policed. It also sidesteps the fact that a ref path forbids characters an
// idempotency key is free to contain.

import { createHash } from 'node:crypto';

/** Fixed width so LEXICAL and NUMERIC ref ordering coincide. */
export const SEQ_WIDTH = 10;

/**
 * Zero-pad a seq for use in a ref name.
 *
 * Probe J measured that BOTH channels -- `git ls-remote` and the REST
 * matching-refs endpoint -- return refs in LEXICAL order:
 *
 *     refs/seq/probe/10, refs/seq/probe/100, refs/seq/probe/2, refs/seq/probe/9
 *
 * Unpadded, "10" sorts before "9". That is the same trap blackboard.md already
 * documents for ZCQL ("a string qty put 100 before 9 in every ordered query"),
 * arriving through a completely different door. Padding makes the natural sort
 * the correct sort, so a caller cannot get this wrong by being reasonable.
 */
export function padSeq(seq: number): string {
  return padFixed(seq, SEQ_WIDTH, 'seq');
}

/**
 * Epoch MILLISECONDS are 13 digits, not 10, so heartbeat timestamps get their
 * own width.
 *
 * This split exists because the shared-width version threw on the first real
 * timestamp. That was the guard working: it refused to wrap rather than emit a
 * truncated name that would have sorted a live agent below a dead one. Widening
 * `SEQ_WIDTH` to 13 for everything would have "fixed" it by making every seq ref
 * three characters longer for no reason; two named widths says what each is.
 *
 * 13 digits holds until the year 2286.
 */
export const TS_WIDTH = 13;

export function padTs(ms: number): string {
  return padFixed(ms, TS_WIDTH, 'timestamp');
}

function padFixed(value: number, width: number, what: string): string {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${what} must be a non-negative integer, got ${value}`);
  }
  const s = String(value);
  if (s.length > width) {
    // Silently wrapping would reorder the ledger. Fail loudly instead: past this
    // range the route needs a different scheme, and it should say so.
    throw new RangeError(`${what} ${value} exceeds ${width} digits; ref ordering would break`);
  }
  return s.padStart(width, '0');
}

/** Parse a padded seq back out of a ref name. Unparseable is a hard error. */
export function parseSeq(text: string): number {
  if (!/^\d+$/.test(text)) {
    // "Unverifiable is not true" (order 0021). A ref whose seq we cannot read
    // must not silently become 0 -- that is how a ledger restarts and reissues
    // every seq it ever gave out.
    throw new RangeError(`not a seq: ${JSON.stringify(text)}`);
  }
  return Number(text);
}

/**
 * Hash one part of a composite key. Fixed-length hex, so concatenating two of
 * them cannot be ambiguous.
 */
function part(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32);
}

/**
 * Composite key, rule B from the checklist. Each part hashed separately, then
 * combined, so `scopedKey("a:b","c") !== scopedKey("a","b:c")` structurally
 * rather than by policing a separator.
 */
export function scopedKey(...parts: string[]): string {
  if (parts.length === 0) throw new RangeError('scopedKey needs at least one part');
  return parts.map(part).join('');
}

/** A project's ref namespace. Everything this adapter writes lives under it. */
export class RefLayout {
  readonly root: string;
  readonly project_id: string;

  constructor(project_id: string) {
    this.project_id = project_id;
    if (!/^[A-Za-z0-9._-]+$/.test(project_id)) {
      // A project id reaching a ref path unvalidated is a path-injection hole:
      // "../../heads/main" would rewrite a branch.
      throw new RangeError(`project_id is not ref-safe: ${JSON.stringify(project_id)}`);
    }
    this.root = `refs/agentic/${project_id}`;
  }

  /** The counter. Exactly one of these exists; its NAME is the current value. */
  seqRef(seq: number): string { return `${this.root}/seq/${padSeq(seq)}`; }
  get seqGlob(): string { return `${this.root}/seq/*`; }

  /** One ref per event. The commit message carries the event JSON. */
  eventRef(seq: number): string { return `${this.root}/ev/${padSeq(seq)}`; }
  get eventGlob(): string { return `${this.root}/ev/*`; }

  /** Claim. Create-if-absent decides the winner. */
  claimRef(task_id: string): string { return `${this.root}/claims/${safe(task_id)}`; }
  get claimGlob(): string { return `${this.root}/claims/*`; }

  /** Scope lock, one per agent. The commit message carries the globs. */
  lockRef(agent_id: string): string { return `${this.root}/locks/${safe(agent_id)}`; }
  get lockGlob(): string { return `${this.root}/locks/*`; }

  /** Heartbeat. The TIMESTAMP IS THE REF NAME -- no object read to read it. */
  heartbeatRef(agent_id: string, at_ms: number): string {
    return `${this.root}/hb/${safe(agent_id)}/${padTs(at_ms)}`;
  }
  heartbeatAgentGlob(agent_id: string): string { return `${this.root}/hb/${safe(agent_id)}/*`; }
  get heartbeatGlob(): string { return `${this.root}/hb/*`; }

  /**
   * Idempotency. Hashed because the key is client-supplied (MB1a) and must not
   * reach a ref path raw.
   */
  dedupeRef(idempotency_key: string): string {
    return `${this.root}/dedupe/${scopedKey(this.project_id, idempotency_key)}`;
  }

  /** Agent and task registration, so a project has state before any event. */
  agentRef(agent_id: string): string { return `${this.root}/agents/${safe(agent_id)}`; }
  get agentGlob(): string { return `${this.root}/agents/*`; }
  taskRef(task_id: string): string { return `${this.root}/tasks/${safe(task_id)}`; }
  get taskGlob(): string { return `${this.root}/tasks/*`; }

  get allGlob(): string { return `${this.root}/*`; }
}

/**
 * A single ref path component. Rejects rather than sanitises: quietly rewriting
 * an id would make two different agents share one ref.
 */
function safe(component: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(component) || component === '.' || component === '..') {
    throw new RangeError(`not ref-safe: ${JSON.stringify(component)}`);
  }
  return component;
}

/** Last path component of a ref. */
export function refTail(ref: string): string {
  const i = ref.lastIndexOf('/');
  return i === -1 ? ref : ref.slice(i + 1);
}

/** Second-to-last component -- the agent id in a heartbeat ref. */
export function refParent(ref: string): string {
  const parts = ref.split('/');
  return parts[parts.length - 2] ?? '';
}
