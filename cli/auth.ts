// `flotilla login` — the loopback flow, and the credential store.
//
// Shaped after `gh auth login` and `firebase login`, for the reason those tools are shaped that
// way: THE CLI NEVER HANDLES THE PASSWORD. The user signs in in their browser, where a real
// provider and a real Firebase Auth session already work, and the browser hands back a token.
//
// NO SERVER IS NEEDED FOR THIS STEP. A listener on 127.0.0.1 and a browser are the whole
// mechanism. The server is needed for the WRITE path (functions/src/write-api.ts), which is a
// different problem: authorization has to live somewhere the user cannot edit.
//
// FOUR SECURITY PROPERTIES, each of which is a way this goes wrong if skipped:
//
//   1. RANDOM PORT. A fixed port is a fixed target, and on a shared machine another process can
//      hold it first and receive the credential.
//   2. ONE-TIME NONCE, VALIDATED. Without it, ANY page the user later visits can POST a token at
//      127.0.0.1:<port> and the CLI would store it. That is a login-CSRF: the attacker signs the
//      victim's CLI into the ATTACKER's account, and everything the victim then does happens in
//      a project the attacker controls and can read.
//   3. SINGLE USE. The nonce is burned on first use, so a replayed response cannot overwrite a
//      credential later.
//   4. THE REFRESH TOKEN IS THE DURABLE CREDENTIAL, stored 0600. ID tokens expire in an hour, so
//      storing one as the durable credential produces a CLI that works until lunchtime. ID
//      tokens are minted on demand and never written to disk.

import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Logger } from '../shared/log.ts';

/** ~/.flotilla/credentials.json — outside any repo, so it cannot be committed by accident. */
export const credentialsDir = (home = os.homedir()): string => path.join(home, '.flotilla');
export const credentialsPath = (home = os.homedir()): string =>
  path.join(credentialsDir(home), 'credentials.json');

export interface StoredCredential {
  /** The DURABLE credential. Long-lived, so it is the one worth protecting. */
  refresh_token: string;
  uid: string;
  email?: string;
  /** Which Firebase project this identity belongs to. */
  project_id: string;
  obtained_at: string;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

/** A cryptographically random, URL-safe nonce. Not Math.random — this is a security token. */
export const newNonce = (): string => randomBytes(32).toString('base64url');

export interface LoopbackResult {
  refresh_token: string;
  id_token: string;
  uid: string;
  email?: string;
}

export interface LoopbackHandle {
  port: number;
  nonce: string;
  /** Resolves when a valid response arrives; rejects on timeout or a bad nonce. */
  result: Promise<LoopbackResult>;
  close: () => void;
}

/**
 * Start the loopback listener. Returns immediately with the port and nonce so the caller can
 * build the browser URL; the credential arrives on `result`.
 *
 * Binds 127.0.0.1 explicitly rather than 0.0.0.0: a listener on all interfaces is reachable from
 * the local network, which turns a localhost-only handshake into a remote one.
 */
export function startLoopback(opts: { timeout_ms?: number; log: Logger }): LoopbackHandle {
  const nonce = newNonce();
  let settle: (r: LoopbackResult) => void;
  let fail: (e: Error) => void;
  const result = new Promise<LoopbackResult>((res, rej) => { settle = res; fail = rej; });

  let used = false;
  let server: Server;

  const close = () => {
    try { server?.close(); } catch { /* already closed */ }
  };

  server = createServer((req, res) => {
    // CORS: the hosted board is a different origin, so the browser preflights the POST.
    // Deliberately `*` for the RESPONSE only -- it grants a page the right to read our reply,
    // which carries nothing. It does NOT grant the right to be believed; the nonce does that.
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type');
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405).end('POST only'); return; }

    let body = '';
    req.on('data', (c) => {
      body += c;
      // A hostile local process could stream forever. Cap it; a credential is small.
      if (body.length > 64 * 1024) { req.destroy(); }
    });
    req.on('end', () => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(body) as Record<string, unknown>;
      } catch {
        res.writeHead(400).end('bad json');
        return;
      }

      // PROPERTY 2 and 3. Checked before anything else is read, and burned on first use.
      if (used) {
        opts.log.warn('auth.nonce_replayed', 'a second response arrived; ignoring it', {});
        res.writeHead(409).end('already used');
        return;
      }
      if (typeof parsed.nonce !== 'string' || parsed.nonce !== nonce) {
        // THIS IS THE ATTACK BEING REFUSED: some other page posting a token at our listener.
        //
        // Refused and logged, but NOT fatal to the pending login. Aborting here would hand any
        // page the user happens to visit a denial of service over their login -- one stray POST
        // and the legitimate browser response, arriving a second later, would have nowhere to
        // go. The nonce is not burned either, so the real response still works.
        opts.log.warn('auth.nonce_mismatch', 'rejected a response with a bad nonce; still waiting', {});
        res.writeHead(403).end('bad nonce');
        return;
      }

      const refresh_token = typeof parsed.refresh_token === 'string' ? parsed.refresh_token : '';
      const id_token = typeof parsed.id_token === 'string' ? parsed.id_token : '';
      const uid = typeof parsed.uid === 'string' ? parsed.uid : '';
      if (!refresh_token || !uid) {
        // Correct nonce but nothing usable in it. The nonce is deliberately NOT burned: this is
        // a malformed attempt by the legitimate page, and burning it would make the retry fail
        // for a second, more confusing reason.
        res.writeHead(400).end('missing credential');
        return;
      }

      // Burned only now, on a response that is both authentic AND usable.
      used = true;

      res.writeHead(200, { 'content-type': 'text/plain' }).end('flotilla: signed in. You can close this tab.');
      settle({ refresh_token, id_token, uid, email: typeof parsed.email === 'string' ? parsed.email : undefined });
    });
  });

  // PROPERTY 1: port 0 asks the OS for a free one, so it is unpredictable per run.
  server.listen(0, '127.0.0.1');

  const timeout = setTimeout(() => {
    fail(new AuthError('login timed out waiting for the browser'));
    close();
  }, opts.timeout_ms ?? 180_000);
  void result.finally(() => clearTimeout(timeout)).catch(() => {});

  const address = () => {
    const a = server.address();
    if (a && typeof a === 'object') return a.port;
    return 0;
  };

  return {
    get port() { return address(); },
    nonce,
    result,
    close,
  };
}

/** Wait until the OS has actually assigned a port, so the URL we print is the one in use. */
export function loopbackReady(handle: LoopbackHandle): Promise<number> {
  return new Promise((resolve) => {
    const tick = () => {
      const p = handle.port;
      if (p > 0) resolve(p);
      else setTimeout(tick, 5);
    };
    tick();
  });
}

/**
 * Write the credential 0600, in a directory created 0700.
 *
 * mode on writeFile is masked by the process umask, so the file is chmod'ed explicitly after
 * writing. A credential readable by every account on the machine is not a credential.
 */
export async function saveCredential(cred: StoredCredential, home = os.homedir()): Promise<string> {
  const dir = credentialsDir(home);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => {});
  const file = credentialsPath(home);
  await fs.writeFile(file, `${JSON.stringify(cred, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(file, 0o600);
  return file;
}

export async function loadCredential(home = os.homedir()): Promise<StoredCredential | null> {
  try {
    return JSON.parse(await fs.readFile(credentialsPath(home), 'utf8')) as StoredCredential;
  } catch {
    return null; // not logged in is not an error
  }
}

/**
 * Mint a short-lived ID token from the stored refresh token.
 *
 * This is why the refresh token is what gets stored: ID tokens last an hour, so a CLI that
 * persisted one would work until lunchtime and then fail in a way that looks like a permissions
 * bug. Nothing caches the ID token to disk.
 */
export async function mintIdToken(
  cred: StoredCredential,
  api_key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id_token: string; expires_in: number }> {
  const res = await fetchImpl(`https://securetoken.googleapis.com/v1/token?key=${api_key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: cred.refresh_token }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new AuthError(
      `could not refresh the session (${res.status}: ${String((body as any).error?.message ?? 'unknown')}). ` +
        'Run `flotilla login` again.',
    );
  }
  const id_token = typeof body.id_token === 'string' ? body.id_token : '';
  // Not "it did not throw": a 200 with no token is a failure that would surface much later as an
  // unauthenticated write.
  if (!id_token) throw new AuthError('the token endpoint returned no id_token');
  return { id_token, expires_in: Number(body.expires_in ?? 3600) };
}

/** The URL the browser is sent to. The nonce and port travel in the query string. */
export function loginUrl(board_url: string, port: number, nonce: string): string {
  const u = new URL('/login', board_url);
  u.searchParams.set('port', String(port));
  u.searchParams.set('nonce', nonce);
  return u.toString();
}
