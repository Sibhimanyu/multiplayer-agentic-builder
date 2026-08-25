// A logger with a capture seam.
//
// Non-negotiable H1: no silent failure. Every dropped, capped or truncated thing
// is logged. That is only testable if the tests can read the log, so logging
// goes through this instead of console directly.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogLine {
  level: LogLevel;
  /** Stable machine-readable event name, e.g. 'store.events.capped'. */
  code: string;
  msg: string;
  fields: Record<string, unknown>;
}

export interface Logger {
  debug(code: string, msg: string, fields?: Record<string, unknown>): void;
  info(code: string, msg: string, fields?: Record<string, unknown>): void;
  warn(code: string, msg: string, fields?: Record<string, unknown>): void;
  error(code: string, msg: string, fields?: Record<string, unknown>): void;
}

function emit(level: LogLevel, code: string, msg: string, fields: Record<string, unknown>): void {
  const line = JSON.stringify({ level, code, msg, ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const consoleLogger: Logger = {
  debug: (c, m, f = {}) => emit('debug', c, m, f),
  info: (c, m, f = {}) => emit('info', c, m, f),
  warn: (c, m, f = {}) => emit('warn', c, m, f),
  error: (c, m, f = {}) => emit('error', c, m, f),
};

/** Collects lines in memory so a test can assert one was written. */
export class CapturingLogger implements Logger {
  readonly lines: LogLine[] = [];
  readonly #echo: boolean;
  /** Mirror to the console too. Off in tests to keep output readable. */
  constructor(echo = false) { this.#echo = echo; }

  #push(level: LogLevel, code: string, msg: string, fields: Record<string, unknown>): void {
    this.lines.push({ level, code, msg, fields });
    if (this.#echo) emit(level, code, msg, fields);
  }

  debug(c: string, m: string, f: Record<string, unknown> = {}): void { this.#push('debug', c, m, f); }
  info(c: string, m: string, f: Record<string, unknown> = {}): void { this.#push('info', c, m, f); }
  warn(c: string, m: string, f: Record<string, unknown> = {}): void { this.#push('warn', c, m, f); }
  error(c: string, m: string, f: Record<string, unknown> = {}): void { this.#push('error', c, m, f); }

  /** Every line with this code, newest last. */
  withCode(code: string): LogLine[] { return this.lines.filter((l) => l.code === code); }
  has(code: string): boolean { return this.lines.some((l) => l.code === code); }
  clear(): void { this.lines.length = 0; }
}

export const nullLogger: Logger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
};
