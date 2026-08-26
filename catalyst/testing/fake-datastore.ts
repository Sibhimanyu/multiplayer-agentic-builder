// A Data Store double that reproduces the behaviours we PROBED, not the ones we
// assumed.
//
// Every quirk below is here because a live probe on 2026-08-25 produced it, and
// each one is recorded in docs/handoff/impl-catalyst-notes.md. A fake that is
// merely "a map with unique keys" would pass code that the real platform breaks,
// which is worse than no fake at all.
//
//   P2  is_unique is enforced, rejecting with error_code DUPLICATE_VALUE and a
//       message naming the column.
//   P4  the constraint is CASE-SENSITIVE.
//   P5  a batch INSERT containing one duplicate applies ATOMICALLY -- nothing
//       lands.
//   P6  varchar SILENTLY clamps to 255, on DDL and on write, reporting success.
//   P7  ROWID is NOT monotonic across separate INSERTs. Reproduced, so anything
//       that quietly starts depending on ROWID order fails here rather than in
//       production.
//   --  is_unique is GLOBAL TO THE TABLE, not per project. The defect that has
//       now bitten three times.
//   --  booleans are stored and returned as STRINGS.
//
// It is deliberately not a ZCQL engine. It answers the specific statements this
// build issues, and throws loudly on anything else rather than silently
// returning [] and letting a typo read as "no rows".

import type { ColumnSpec, TableSpec } from '../schema/tables.ts';
import { TABLES, toCreateColumnPayload } from '../schema/tables.ts';
import { VARCHAR_MAX } from '../../shared/sanitize.ts';
import type { Logger } from '../../shared/log.ts';
import { nullLogger } from '../../shared/log.ts';

export interface DuplicateFailure {
  status: 'failure';
  data: { message: string; error_code: 'DUPLICATE_VALUE' };
}

export class FakeDuplicateValue extends Error {
  readonly column: string;
  readonly payload: DuplicateFailure;
  constructor(column: string) {
    const message = `Duplicate value for ${column}. Please give a different value`;
    super(message);
    this.name = 'FakeDuplicateValue';
    this.column = column;
    this.payload = { status: 'failure', data: { message, error_code: 'DUPLICATE_VALUE' } };
  }
}

export interface FakeRow { [column: string]: unknown }

interface FakeTable {
  spec: TableSpec;
  columns: Map<string, ColumnSpec>;
  rows: FakeRow[];
  /** column -> set of taken values. Table-global, exactly like the platform. */
  unique: Map<string, Set<string>>;
}

/** ROWID blocks, so allocation is non-monotonic the way the probe measured. */
class RowIdAllocator {
  #blocks = [52000, 44000, 53000, 47000, 51000, 54000];
  #cursor = 0;
  #withinBlock = 0;

  /** A fresh block per INSERT request; consecutive within one batch. */
  startBatch(): void {
    this.#cursor = (this.#cursor + 1) % this.#blocks.length;
    this.#withinBlock = 0;
  }

  next(): string {
    this.#withinBlock += 1;
    return `530690000000${this.#blocks[this.#cursor] + this.#withinBlock}`;
  }
}

export interface FakeDataStoreOptions {
  log?: Logger;
  /** Injected so rows carry a deterministic CREATEDTIME. */
  now?: () => string;
}

export class FakeDataStore {
  readonly tables = new Map<string, FakeTable>();
  /** Every silent clamp the platform performed. Asserted by the dry run. */
  readonly clamped: { table: string; column: string; was: number; stored: number }[] = [];
  #log: Logger;
  #now: () => string;
  #rowids = new RowIdAllocator();

  constructor(opts: FakeDataStoreOptions = {}) {
    this.#log = opts.log ?? nullLogger;
    this.#now = opts.now ?? (() => new Date().toISOString());
  }

  /** Replay a TableSpec exactly as Create_Table + Create_Column would. */
  createTable(spec: TableSpec): void {
    if (this.tables.has(spec.name)) throw new Error(`table already exists: ${spec.name}`);
    const columns = new Map<string, ColumnSpec>();
    const unique = new Map<string, Set<string>>();

    for (const col of spec.columns) {
      // Round-trip through the real API payload shape, so a column this build
      // could not actually create fails here.
      const payload = toCreateColumnPayload(col);
      const stored: ColumnSpec = { ...col };
      if (payload.data_type === 'varchar') {
        const asked = Number(payload.max_length ?? VARCHAR_MAX);
        // P6: the platform clamps on DDL, silently, reporting success.
        stored.max_length = Math.min(asked, VARCHAR_MAX);
        if (asked > VARCHAR_MAX) {
          this.clamped.push({ table: spec.name, column: col.name, was: asked, stored: VARCHAR_MAX });
        }
      }
      if (payload.is_unique === 'true') unique.set(col.name, new Set());
      columns.set(col.name, stored);
    }

    this.tables.set(spec.name, { spec, columns, rows: [], unique });
  }

  /** Create every declared table. Returns their names. */
  createAll(): string[] {
    for (const spec of TABLES) this.createTable(spec);
    return [...this.tables.keys()];
  }

  #table(name: string): FakeTable {
    const t = this.tables.get(name);
    if (!t) throw new Error(`unknown table: ${name}`);
    return t;
  }

  /**
   * Insert rows.
   *
   * P5: atomic. Uniqueness is checked for the WHOLE batch before anything is
   * written, so a batch containing one duplicate lands nothing.
   */
  insert(table: string, rows: FakeRow[]): FakeRow[] {
    const t = this.#table(table);

    const prepared = rows.map((row) => this.#prepare(t, row));

    // Check against committed rows AND against the rest of this batch: two
    // identical rows in one call collide with each other, not just with history.
    const pending = new Map<string, Set<string>>();
    for (const [column] of t.unique) pending.set(column, new Set());

    for (const row of prepared) {
      for (const [column, taken] of t.unique) {
        const value = row[column];
        if (value === undefined || value === null) continue;
        const key = String(value); // P4: case-sensitive, no normalisation
        if (taken.has(key) || pending.get(column)!.has(key)) {
          throw new FakeDuplicateValue(column);
        }
        pending.get(column)!.add(key);
      }
    }

    this.#rowids.startBatch();
    const written: FakeRow[] = [];
    for (const row of prepared) {
      const stored: FakeRow = {
        ...row,
        ROWID: this.#rowids.next(),
        CREATEDTIME: this.#now(),
        MODIFIEDTIME: this.#now(),
        CREATORID: '53069000000013007',
      };
      for (const [column, taken] of t.unique) {
        const value = stored[column];
        if (value !== undefined && value !== null) taken.add(String(value));
      }
      t.rows.push(stored);
      written.push(stored);
    }
    return written;
  }

  /** Apply the platform's storage semantics to one row before it is written. */
  #prepare(t: FakeTable, row: FakeRow): FakeRow {
    const out: FakeRow = {};
    for (const [key, value] of Object.entries(row)) {
      const col = t.columns.get(key);
      if (!col) throw new Error(`unknown column ${t.spec.name}.${key}`);
      out[key] = this.#coerce(t, col, value);
    }
    for (const col of t.spec.columns) {
      if (col.mandatory && (out[col.name] === undefined || out[col.name] === null)) {
        throw new Error(`${t.spec.name}.${col.name} is mandatory`);
      }
      if (!(col.name in out)) out[col.name] = null;
    }
    return out;
  }

  #coerce(t: FakeTable, col: ColumnSpec, value: unknown): unknown {
    if (value === null || value === undefined) return null;

    if (col.type === 'boolean') {
      // Stored and returned as a STRING. "false" is truthy in JS, which is the
      // entire reason readBool exists.
      return value === true || value === 'true' ? 'true' : 'false';
    }

    if (col.type === 'bigint' || col.type === 'int') {
      const n = Number(value);
      if (!Number.isInteger(n)) throw new Error(`${t.spec.name}.${col.name} expects an integer`);
      return n;
    }

    const text = String(value);

    if (col.type === 'varchar') {
      const max = col.max_length ?? VARCHAR_MAX;
      if (text.length > max) {
        // P6: truncated, silently, with success reported. The response echoes
        // the truncated value, which is the only way a caller can notice.
        this.clamped.push({ table: t.spec.name, column: col.name, was: text.length, stored: max });
        this.#log.warn('fake.varchar_clamped', 'value silently truncated by the platform', {
          table: t.spec.name, column: col.name, was: text.length, stored: max,
        });
        return text.slice(0, max);
      }
      return text;
    }

    if (col.type === 'text' && text.length > 10_000) {
      this.clamped.push({ table: t.spec.name, column: col.name, was: text.length, stored: 10_000 });
      return text.slice(0, 10_000);
    }

    return text;
  }

  /**
   * Answer the specific statements this build issues.
   *
   * Anything unrecognised throws. A general-purpose parser here would be a
   * second implementation to keep correct, and a fake that returns [] for a
   * statement it did not understand turns a typo into "no rows found".
   */
  query(zcql: string): unknown[] {
    const sql = zcql.trim();

    const maxSeq = /^SELECT MAX\(seq\) AS max_seq FROM events$/i.exec(sql);
    if (maxSeq) {
      const rows = this.#table('events').rows;
      const max = rows.length === 0 ? 0 : Math.max(...rows.map((r) => Number(r.seq)));
      return [{ max_seq: max }];
    }

    const events = /FROM events WHERE project_id = '(.*?)' AND seq > (\d+) ORDER BY seq LIMIT 0, (\d+)$/i.exec(sql);
    if (events) {
      const [, project, since, limit] = events;
      const unescaped = project.replace(/''/g, "'");
      return this.#table('events').rows
        .filter((r) => r.project_id === unescaped && Number(r.seq) > Number(since))
        .sort((a, b) => Number(a.seq) - Number(b.seq)) // ORDER BY seq, never ROWID
        .slice(0, Number(limit))
        .map((r) => ({ events: r }));
    }

    const byKey = /FROM (\w+) WHERE (\w+) = '(.*?)' LIMIT 0, 1$/i.exec(sql);
    if (byKey) {
      const [, table, column, value] = byKey;
      const unescaped = value.replace(/''/g, "'");
      const row = this.#table(table).rows.find((r) => String(r[column]) === unescaped);
      return row ? [{ [table]: row }] : [];
    }

    const locks = /FROM scope_locks WHERE project_id = '(.*?)' ORDER BY acquired_at LIMIT 0, (\d+)$/i.exec(sql);
    if (locks) {
      const [, project, limit] = locks;
      const unescaped = project.replace(/''/g, "'");
      return this.#table('scope_locks').rows
        .filter((r) => r.project_id === unescaped)
        .slice(0, Number(limit))
        .map((r) => ({ scope_locks: r }));
    }

    throw new Error(`FakeDataStore cannot answer this statement, so it will not pretend to: ${sql}`);
  }

  rowCount(table: string): number { return this.#table(table).rows.length; }
  allRows(table: string): FakeRow[] { return [...this.#table(table).rows]; }
}
