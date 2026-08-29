// The seam between the adapter and GitHub.
//
// Route G has TWO channels and they fail differently, so both go through here:
//
//   git   -- the write path. Ref updates are the atomic primitive.
//   REST  -- the read path. Cheap, structured, and free when conditional.
//
// Everything below is injectable, for two reasons that are both requirements
// rather than conveniences:
//
//   1. Order 0020: the status -> error mapping IS the contract with the retry
//      policy, and it must be verified through an injected transport rather
//      than by provoking a live 429. Zero quota, and it covers cases that are
//      impractical to cause on demand.
//   2. The conformance harness needs setOffline / setBusy / revoke, and a real
//      backend has no switch for those.
//
// Order 0017 binds this file hardest: NEVER match on an error message string.
// git's stderr is prose. What is structured is the --porcelain status character
// and the process exit code; what is structured on the REST side is the HTTP
// status. Those three are the only things anything here branches on.

import { spawn } from 'node:child_process';

import {
  NotProvisionedError, StoreAuthError, StoreBusyError, StoreError, StoreOfflineError,
} from '../../shared/store/errors.ts';

// ---- git ------------------------------------------------------------------

/**
 * One line of `git push --porcelain` output.
 *
 * The leading character is the whole point. Probe L measured that `rc` alone
 * CANNOT distinguish a real create from a no-op:
 *
 *   *  <sha>:<ref>  [new reference]   rc=0   <- we won
 *   =  <sha>:<ref>  [up to date]      rc=0   <- ref ALREADY holds our sha,
 *                                                the lease was never evaluated
 *   !  <sha>:<ref>  [rejected] ...    rc=1   <- we lost
 *
 * Reading `rc` and calling `0` a win is the exact defect that would let every
 * concurrent claimant believe it won while A2 still passed 50/50.
 */
export type PushFlag = '*' | '=' | '!' | '-' | ' ' | '+';

export interface PushRefResult {
  flag: PushFlag;
  /** "<local>:<remote>" as git echoes it, or ":<remote>" for a delete. */
  spec: string;
  remote_ref: string;
  summary: string;
}

export interface PushResult {
  code: number;
  refs: PushRefResult[];
  /** Kept for logs only. Never branched on. */
  stderr: string;
  /** The child exceeded its deadline and was killed. See GIT_TIMEOUT_MS. */
  timed_out?: boolean;
}

/**
 * Deadline for any git child process.
 *
 * GIT HAS NO DEFAULT TIMEOUT, and a wedged `git send-pack` waits forever.
 * Measured: a push to `refs/.../ev/0000000004` sat in `send-pack` indefinitely
 * while `github.com` was demonstrably reachable from the same machine in the
 * same minute (probe `pushtime.py`: push 1.9 s, ls-remote 1.3 s). The adapter
 * had no deadline, so it waited with it.
 *
 * This is the second of two independent hangs found the same afternoon, and the
 * worse one: the first only affected tests, because it needed the FakeClock.
 * This one affects PRODUCTION -- a CLI daemon would sit on a wedged push
 * forever, appearing to work and publishing nothing.
 *
 * 45 s is well clear of the measured p95 for every git operation this adapter
 * performs (push p95 ~2.4 s, fetch ~1.5 s), so a timeout means something is
 * genuinely wrong rather than merely slow.
 */
export const GIT_TIMEOUT_MS = Number(process.env.GIT_TIMEOUT_MS ?? 45_000);

export interface GitRunner {
  /** Run `git push --porcelain --atomic <args>` and parse the per-ref status. */
  push(args: string[]): Promise<PushResult>;
  /** Run any other git command. Used for fetch, cat-file, commit-tree. */
  run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  /**
   * Read many objects through ONE `git cat-file --batch` process.
   *
   * Reading N objects with N `git cat-file` invocations is N process spawns,
   * and it made `readEvents` grow with ledger size rather than page size: the
   * G1 tight-loop readback degraded to ~77 s per append by the 50th event and
   * was measuring my subprocess overhead rather than GitHub. `--batch` takes
   * the shas on stdin and streams every object back over one pipe.
   */
  catFileBatch(shas: string[]): Promise<Map<string, string>>;
}

const PUSH_FLAGS = new Set<string>(['*', '=', '!', '-', ' ', '+']);

export function parsePorcelain(stdout: string): PushRefResult[] {
  const out: PushRefResult[] = [];
  for (const raw of stdout.split('\n')) {
    if (!raw || raw.startsWith('To ') || raw === 'Done') continue;
    const flag = raw[0];
    if (!PUSH_FLAGS.has(flag)) continue;
    const rest = raw.slice(1).replace(/^\t/, '');
    const parts = rest.split('\t');
    const spec = parts[0] ?? '';
    const summary = parts[1] ?? '';
    out.push({
      flag: flag as PushFlag,
      spec,
      remote_ref: spec.includes(':') ? spec.slice(spec.indexOf(':') + 1) : spec,
      summary,
    });
  }
  return out;
}

export function createGitRunner(cwd: string, env: NodeJS.ProcessEnv = {}): GitRunner {
  async function exec(
    args: string[],
  ): Promise<{ code: number; stdout: string; stderr: string; timed_out?: boolean }> {
    return new Promise((resolve, reject) => {
      const child = spawn('git', args, {
        cwd,
        env: {
          ...process.env,
          ...env,
          // A prompt in a non-interactive run is a hang, not a failure. Make it
          // fail so it can be mapped instead of blocking the suite forever.
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: 'echo',
        },
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;

      // The deadline. Without it a wedged send-pack waits forever and takes the
      // caller with it. SIGTERM first so git can clean up its helper processes,
      // then SIGKILL if it will not go.
      const deadline = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        child.kill('SIGTERM');
        const hard = setTimeout(() => { if (!settled) child.kill('SIGKILL'); }, 2_000);
        if (typeof hard.unref === 'function') hard.unref();
      }, GIT_TIMEOUT_MS);
      if (typeof deadline.unref === 'function') deadline.unref();

      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (err) => {
        settled = true;
        clearTimeout(deadline);
        reject(err);
      });
      child.on('close', (code) => {
        settled = true;
        clearTimeout(deadline);
        resolve({
          code: timedOut ? GIT_PUSH_FATAL : (code ?? -1),
          stdout,
          stderr: timedOut
            ? `${stderr}\ngit exceeded ${GIT_TIMEOUT_MS} ms and was killed: ${args[0]}`
            : stderr,
          timed_out: timedOut,
        });
      });
    });
  }

  return {
    async push(args) {
      const r = await exec(['push', '--porcelain', ...args]);
      return {
        code: r.code, refs: parsePorcelain(r.stdout), stderr: r.stderr,
        ...(r.timed_out ? { timed_out: true } : {}),
      };
    },
    run: exec,

    async catFileBatch(shas) {
      const out = new Map<string, string>();
      if (shas.length === 0) return out;
      return new Promise((resolve, reject) => {
        const child = spawn('git', ['cat-file', '--batch'], {
          cwd,
          env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' },
        });
        const chunks: Buffer[] = [];
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => chunks.push(d));
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('error', reject);
        child.on('close', () => {
          // --batch emits, per object: "<sha> <type> <size>\n<contents>\n".
          // Parse by the DECLARED SIZE rather than by scanning for a
          // delimiter -- a commit message can contain anything, including a
          // line that looks like the next header.
          const buf = Buffer.concat(chunks);
          let i = 0;
          while (i < buf.length) {
            const nl = buf.indexOf(0x0a, i);
            if (nl === -1) break;
            const header = buf.subarray(i, nl).toString('utf8');
            const parts = header.split(' ');
            if (parts.length < 3) {
              // "<sha> missing" -- report it rather than skipping silently.
              reject(new Error(`git cat-file --batch: ${header} (stderr: ${stderr.slice(0, 200)})`));
              return;
            }
            const sha = parts[0]!;
            const size = Number(parts[2]);
            if (!Number.isFinite(size)) {
              reject(new Error(`git cat-file --batch: unparseable size in "${header}"`));
              return;
            }
            const start = nl + 1;
            out.set(sha, buf.subarray(start, start + size).toString('utf8'));
            i = start + size + 1; // trailing newline
          }
          resolve(out);
        });
        child.stdin.write(shas.join('\n') + '\n');
        child.stdin.end();
      });
    },
  };
}

// ---- REST -----------------------------------------------------------------

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface HttpTransport {
  (url: string, init: { method?: string; headers: Record<string, string> }): Promise<HttpResponse>;
}

/**
 * Every conditional request in this adapter goes through here with a PINNED
 * Accept header.
 *
 * Probe H measured why this is not optional: the ETag is media-type dependent.
 * An ETag obtained WITH `Accept: application/vnd.github+json` and replayed
 * WITHOUT it returns 200, not 304 -- and 200 costs a rate-limit unit while 304
 * costs zero. `subscribe` polls faster than 5,000/hour, so it is viable ONLY
 * because 304s are free. An Accept header that drifts between the two paths
 * exhausts the hour's quota in about fifty minutes, silently, with correct
 * looking data right up to the 403.
 *
 * One chokepoint, one Accept value, no exceptions.
 */
export const GITHUB_ACCEPT = 'application/vnd.github+json';

export function createHttpTransport(): HttpTransport {
  return async (url, init) => {
    const res = await fetch(url, { method: init.method ?? 'GET', headers: init.headers });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    return { status: res.status, headers, body: await res.text() };
  };
}

// ---- error mapping --------------------------------------------------------
//
// Normative in store-interface.md and generalised by order 0020:
//   401/403 -> StoreAuthError   (stop; a revoked token does not become valid)
//   429     -> StoreBusyError   (retry, honouring Retry-After)
//   5xx     -> StoreOfflineError (queue, never discard)
//   transport failure -> StoreOfflineError
//   other 4xx -> StoreError
//
// 403 is deliberately split: GitHub returns 403 BOTH for a permission problem
// and for a secondary rate limit. Collapsing them would either retry a
// permission error forever or drop a write that only needed a wait, so the
// rate-limit headers decide -- structured fields, not the message.

export interface MapOptions { operation: string }

export function mapHttpStatus(res: HttpResponse, opts: MapOptions): StoreError {
  const { status, headers } = res;
  const backend_message = res.body?.slice(0, 400);

  if (status === 401) {
    return new StoreAuthError('agent token is revoked or invalid', { backend_message });
  }
  if (status === 403) {
    // A 403 carrying an exhausted quota is a WAIT, not a permission failure.
    const remaining = headers['x-ratelimit-remaining'];
    const retryAfter = headers['retry-after'];
    if (remaining === '0' || retryAfter !== undefined) {
      return new StoreBusyError('github rate limit reached', {
        backend_message,
        retry_after_ms: retryAfterMs(headers),
      });
    }
    return new StoreAuthError('forbidden', { backend_message });
  }
  if (status === 429) {
    return new StoreBusyError('github secondary rate limit', {
      backend_message,
      retry_after_ms: retryAfterMs(headers),
    });
  }
  if (status >= 500) {
    return new StoreOfflineError(`github returned ${status}`, { backend_message });
  }
  return new StoreError(`${opts.operation} failed with HTTP ${status}`, {
    backend_message,
    cause_code: String(status),
  });
}

function retryAfterMs(headers: Record<string, string>): number | undefined {
  const ra = headers['retry-after'];
  if (ra !== undefined) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return Math.max(0, secs) * 1000;
  }
  const reset = headers['x-ratelimit-reset'];
  if (reset !== undefined) {
    const at = Number(reset);
    // Only meaningful as a duration; a negative one means the window already
    // rolled, so treat it as "no advice" rather than as zero wait.
    if (Number.isFinite(at)) {
      const ms = at * 1000 - Date.now();
      if (ms > 0) return ms;
    }
  }
  return undefined;
}

/**
 * `git push` exit codes, mapped WITHOUT reading stderr.
 *
 * Probe I measured the whole space:
 *   rc=0    success (but see PushFlag -- 0 does not mean "won")
 *   rc=1    a ref was rejected. A protocol outcome, not a transport failure.
 *   rc=128  auth, offline, DNS and missing-repo ALL collapse here.
 *
 * rc=128 conflates classes that need OPPOSITE responses: StoreAuthError says
 * stop, StoreOfflineError says queue and keep working. Telling them apart from
 * git's prose is exactly what order 0017 forbids, so we do not: the caller
 * resolves 128 by making one REST call and reading its HTTP status.
 */
export const GIT_PUSH_REJECTED = 1;
export const GIT_PUSH_FATAL = 128;

export interface Probe { (): Promise<HttpResponse | 'transport-failure'> }

/**
 * Turn an rc=128 into the right error by asking a structured channel.
 * `probe` should hit a cheap authenticated endpoint on the same repo.
 */
export async function classifyGitFatal(
  probe: Probe, operation: string, stderr: string,
): Promise<StoreError> {
  let res: HttpResponse | 'transport-failure';
  try {
    res = await probe();
  } catch {
    res = 'transport-failure';
  }
  if (res === 'transport-failure') {
    return new StoreOfflineError('github is unreachable', { backend_message: stderr.slice(0, 400) });
  }
  if (res.status >= 200 && res.status < 300) {
    // Repo and credentials are both fine, so whatever git hit was transient.
    // Offline is the retryable answer and the caller queues rather than losing
    // the write.
    return new StoreOfflineError(`${operation}: git failed but the API is reachable`, {
      backend_message: stderr.slice(0, 400),
    });
  }
  return mapHttpStatus(res, { operation });
}

// ---- fault injection ------------------------------------------------------
//
// Wraps a real transport so the conformance harness can drive the failure
// paths. This is NOT a substitute backend: every non-faulted call goes to the
// real GitHub. Order 0019's substitution rule is satisfied because nothing
// measured changes -- with all faults off this wrapper is a pass-through.

export interface Faultable {
  offline: boolean;
  busy: boolean;
  busy_retry_after_ms?: number;
  revoked: Set<string>;
  /** Hold the folded snapshot behind the ledger, as a debounced writer does. */
  frozen: boolean;
}

export function newFaults(): Faultable {
  return { offline: false, busy: false, revoked: new Set(), frozen: false };
}

/** Throws the injected fault for `agent_id`, if any. Call before every op. */
export function assertNoFault(f: Faultable, operation: string, agent_id?: string): void {
  if (agent_id !== undefined && f.revoked.has(agent_id)) {
    throw new StoreAuthError('agent token is revoked or invalid');
  }
  if (f.offline) throw new StoreOfflineError('backend is unreachable');
  if (f.busy) {
    throw new StoreBusyError('backend is rate limited', {
      ...(f.busy_retry_after_ms !== undefined ? { retry_after_ms: f.busy_retry_after_ms } : {}),
    });
  }
  void operation;
}

export { NotProvisionedError };
